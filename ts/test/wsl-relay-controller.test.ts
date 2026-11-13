/* eslint-disable sonarjs/no-hardcoded-ip -- fixture addresses, nothing is contacted */
import assert from 'tjs:assert';
import { WebUIServer } from '../src/web/server/web-ui-server.js';
import type { Broadcaster } from '../src/web/server/broadcaster.js';
import type { WslRelayPort } from '../src/web/server/wsl-relay-controller.js';
import { buildDiagnostics } from '../src/web/server/diagnostics.js';
import { PersistedSettings } from '../src/infra/settings.js';
import type { WslRelayStatus } from '../src/web/contract-wsl-relay.js';
import type { PairingRoute, PairingRouteStatus } from '../src/web/contract-pairing-route.js';
import { testAsync as test, summaryExit } from './helpers/harness.js';

console.log('\nwsl-relay controller + routes');

const ROOT = `${tjs.tmpDir}/wsl-relay-controller-test-${tjs.pid}`;
const PORT = 13477;

const OFF: WslRelayStatus = {
  supported: true,
  enabled: false,
  state: 'off',
  wslIp: null,
  ipChanged: false,
  distro: null,
  detail: null,
  fixCommand: null,
};

/** A relay whose enable moves to `checking` at once and never finishes by itself. */
function fakePort(): WslRelayPort & { calls: string[]; setEnabled(on: boolean): void } {
  let s = OFF;
  const calls: string[] = [];
  return {
    calls,
    status: () => s,
    setEnabled: (on) => {
      calls.push(`setEnabled(${on})`);
      s = on ? { ...OFF, enabled: true, state: 'checking' } : OFF;
    },
    recheck: () => {
      calls.push('recheck');
      return Promise.resolve(s);
    },
  };
}

const pairingStatus = (): PairingRouteStatus => ({
  supported: true,
  route: 'none',
  elgatoVersion: null,
  relayIp: null,
  relayVersion: null,
  versionMismatch: false,
  announcedAt: null,
  paired: false,
  wizardDismissed: false,
});

const settings = new PersistedSettings(ROOT);
const ui = new WebUIServer(PORT, [], 'real', settings);
await ui.start();
const sent: { event: string; data: unknown }[] = [];
const bus = (ui as unknown as { bus: Broadcaster }).bus;
bus
  .websocketHandlers(() => {})
  .open({
    data: undefined,
    sendText: (msg: string) => sent.push(JSON.parse(msg) as { event: string; data: unknown }),
    sendBinary: () => {},
    close: () => {},
  });

const base = `http://127.0.0.1:${ui.port}`;
const post = (path: string, body: string): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

try {
  await test('without a relay attached, every endpoint reports unsupported', async () => {
    const got = (await (await fetch(`${base}/api/wsl-relay`)).json()) as WslRelayStatus;
    assert.equal(got.supported, false);
    const res = await post('/api/wsl-relay', '{"enabled":true}');
    assert.equal(((await res.json()) as WslRelayStatus).state, 'off');
    assert.equal(settings.pairingRoute.route, 'none', 'an unsupported system persists nothing');
  });

  const port = fakePort();
  ui.wslRelay.attach(port);
  // The real route state drives the relay from setRoute; this fake does the same two things.
  ui.pairingRoute.attach({
    status: () => ({ ...pairingStatus(), route: settings.pairingRoute.route }),
    setRoute: (route: PairingRoute) => {
      settings.setPairingRoute({ route });
      port.setEnabled(route === 'wsl');
      return Promise.resolve({ ...pairingStatus(), route });
    },
    dismiss: () => pairingStatus(),
    probe: () => Promise.reject(new Error('unused')),
  });

  await test('a body that is not {enabled: boolean} is a 400', async () => {
    for (const body of ['{}', '{"enabled":"yes"}', '{"enabled":1}', 'null', 'not json']) {
      assert.equal((await post('/api/wsl-relay', body)).status, 400, body);
    }
    assert.deepEqual(port.calls, []);
    assert.equal(settings.pairingRoute.route, 'none');
  });

  await test('POST enabled:true selects the wsl route, starts the flow and replies in `checking`', async () => {
    const res = await post('/api/wsl-relay', '{"enabled":true}');
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as WslRelayStatus).state, 'checking');
    assert.equal(settings.pairingRoute.route, 'wsl');
    assert.deepEqual(port.calls, ['setEnabled(true)']);
    const got = (await (await fetch(`${base}/api/wsl-relay`)).json()) as WslRelayStatus;
    assert.equal(got.state, 'checking');
  });

  await test('POST enabled:false selects the none route and replies `off`', async () => {
    const res = await post('/api/wsl-relay', '{"enabled":false}');
    assert.equal(((await res.json()) as WslRelayStatus).state, 'off');
    assert.equal(settings.pairingRoute.route, 'none');
  });

  await test('POST enabled:false leaves another route alone', async () => {
    port.calls.length = 0;
    settings.setPairingRoute({ route: 'device' });
    const res = await post('/api/wsl-relay', '{"enabled":false}');
    assert.equal(res.status, 200);
    assert.equal(settings.pairingRoute.route, 'device');
    assert.deepEqual(port.calls, []);
    settings.setPairingRoute({ route: 'none' });
  });

  await test('POST /recheck runs the relay and replies with its status', async () => {
    port.calls.length = 0;
    const res = await post('/api/wsl-relay/recheck', '');
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as WslRelayStatus).supported, true);
    assert.deepEqual(port.calls, ['recheck']);
  });

  await test('publish broadcasts the `wslRelay` WS event', () => {
    sent.length = 0;
    ui.wslRelay.publish({ ...OFF, enabled: true, state: 'ready', wslIp: '172.28.16.5' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.event, 'wslRelay');
    assert.equal((sent[0]!.data as WslRelayStatus).wslIp, '172.28.16.5');
  });

  await test('the diagnostics report has a one-line wsl relay section', () => {
    const header = { version: 'x', platform: 'p', txikiVersion: 't', logLevel: 'info' };
    const ready: WslRelayStatus = {
      ...OFF,
      enabled: true,
      state: 'ready',
      wslIp: '172.28.16.5',
      distro: 'Ubuntu-24.04',
    };
    const report = buildDiagnostics({ header, wslRelay: ready });
    assert.ok(
      report.includes(
        '──── wsl relay ────\nenabled=true state=ready wslIp=172.28.16.5 distro=Ubuntu-24.04\n',
      ),
    );
    assert.ok(
      buildDiagnostics({ header, wslRelay: { ...OFF, supported: false } }).includes(
        'not supported on this system',
      ),
    );
  });
} finally {
  await ui.stop();
  await tjs.remove(ROOT).catch(() => undefined);
}

summaryExit();
