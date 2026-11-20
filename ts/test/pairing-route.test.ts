/* eslint-disable sonarjs/no-hardcoded-ip -- fixture addresses, nothing is contacted */
import assert from 'tjs:assert';
import { PairingRouteState, isRelayRoute } from '../src/infra/pairing-route.js';
import type { PairingRouteDeps } from '../src/infra/pairing-route.js';
import type { PairingRouteSettings } from '../src/infra/settings-store.js';
import type { PairingProbe, PairingRouteStatus } from '../src/web/contract-pairing-route.js';
import type { WslRelayStatus } from '../src/web/contract-wsl-relay.js';
import { WebUIServer } from '../src/web/server/web-ui-server.js';
import { PersistedSettings } from '../src/infra/settings.js';
import { testAsync as test, summaryExit } from './helpers/harness.js';

console.log('\npairing-route state + controller + routes');

const WSL_OFF: WslRelayStatus = {
  supported: true,
  enabled: false,
  state: 'off',
  wslIp: null,
  ipChanged: false,
  distro: null,
  detail: null,
  fixCommand: null,
};

function rig(
  over: Partial<PairingRouteDeps> = {},
  initial: PairingRouteSettings = { route: 'none' },
) {
  const log: string[] = [];
  const published: PairingRouteStatus[] = [];
  const store = { current: initial };
  let wsl = WSL_OFF;
  let paired = false;
  let version: string | undefined = '7.6.1';
  const clock = { t: 1_000_000 };
  let tokens = 0;
  const deps: PairingRouteDeps = {
    supported: true,
    version: '0.23.0',
    settings: {
      get pairingRoute() {
        return store.current;
      },
      setPairingRoute: (v) => {
        log.push(`save(${v.route})`);
        store.current = v;
      },
    },
    wsl: {
      setEnabled: (on) => {
        log.push(`wsl(${on})`);
        wsl = on ? { ...WSL_OFF, enabled: true, state: 'checking' } : WSL_OFF;
        return Promise.resolve(wsl);
      },
      status: () => wsl,
    },
    applyMdns: (on) => log.push(`mdns(${on})`),
    readElgatoVersion: () => {
      log.push('version');
      return Promise.resolve(version);
    },
    paired: () => paired,
    onStatus: (s) => published.push(s),
    newToken: () => `${'a'.repeat(31)}${(tokens++).toString(16)}`,
    now: () => clock.t,
    ...over,
  };
  return {
    state: new PairingRouteState(deps),
    log,
    published,
    store,
    setWsl: (s: WslRelayStatus) => (wsl = s),
    setPaired: (p: boolean) => (paired = p),
    setVersion: (v: string | undefined) => (version = v),
    clock,
  };
}

await test('isRelayRoute: the relay routes silence mDNS, none and downgrade do not', () => {
  for (const r of ['wsl', 'device', 'container', 'orbstack'] as const) assert.ok(isRelayRoute(r));
  for (const r of ['none', 'downgrade'] as const) assert.equal(isRelayRoute(r), false);
});

await test('setRoute wsl -> device -> none drives the relay and mDNS in order', async () => {
  const r = rig();
  const s = await r.state.setRoute('wsl');
  assert.equal(s.route, 'wsl');
  assert.deepEqual(r.log, ['save(wsl)', 'wsl(true)', 'mdns(true)']);
  r.log.length = 0;
  await r.state.setRoute('device');
  assert.deepEqual(r.log, ['save(device)', 'wsl(false)', 'mdns(true)']);
  r.log.length = 0;
  await r.state.setRoute('none');
  assert.deepEqual(r.log, ['save(none)', 'mdns(false)']);
  assert.equal(r.published.length, 3);
  assert.deepEqual(
    r.published.map((p) => p.route),
    ['wsl', 'device', 'none'],
  );
});

await test('setRoute to the current route changes nothing', async () => {
  const r = rig({}, { route: 'downgrade' });
  await r.state.setRoute('downgrade');
  assert.deepEqual(r.log, []);
  assert.deepEqual(r.published, []);
});

await test('a route change drops the announced relay IP but keeps the WSL IP and token', async () => {
  const r = rig(
    {},
    { route: 'device', relayIp: '192.168.1.40', wslLastIp: '172.20.1.5', token: 'a'.repeat(32) },
  );
  assert.equal(r.state.status().relayIp, '192.168.1.40');
  await r.state.setRoute('downgrade');
  assert.deepEqual(r.store.current, {
    route: 'downgrade',
    wslLastIp: '172.20.1.5',
    token: 'a'.repeat(32),
  });
  assert.equal(r.state.status().relayIp, null);
});

await test('start applies mDNS before it starts the WSL relay, reads the version last', async () => {
  const r = rig({}, { route: 'wsl' });
  await r.state.start();
  assert.deepEqual(r.log, ['mdns(true)', 'wsl(true)', 'version']);
  assert.equal(r.state.status().elgatoVersion, '7.6.1');
  assert.equal(r.published.at(-1)?.elgatoVersion, '7.6.1');
});

await test('start on a non-wsl route leaves the relay off; a missing app or a throw is null', async () => {
  const r = rig({}, { route: 'device' });
  await r.state.start();
  assert.deepEqual(r.log, ['mdns(true)', 'save(device)', 'version']); // save: the token
  const none = rig();
  none.setVersion(undefined);
  await none.state.start();
  assert.equal(none.state.status().elgatoVersion, null);
  const boom = rig({
    readElgatoVersion: () => Promise.reject(new Error('powershell missing')),
  });
  await boom.state.start();
  assert.equal(boom.state.status().elgatoVersion, null);
});

await test('relayIp follows the WSL IP on the wsl route and republishes', () => {
  const r = rig({}, { route: 'wsl' });
  assert.equal(r.state.status().relayIp, null);
  const ready: WslRelayStatus = { ...WSL_OFF, enabled: true, state: 'ready', wslIp: '172.28.16.5' };
  r.setWsl(ready);
  r.state.onWslStatus(ready);
  assert.equal(r.state.status().relayIp, '172.28.16.5');
  assert.equal(r.published.at(-1)?.relayIp, '172.28.16.5');
  // Another route reads its own IP and ignores the WSL relay.
  const other = rig({}, { route: 'device', relayIp: '192.168.1.40' });
  other.setWsl(ready);
  other.state.onWslStatus(ready);
  assert.equal(other.state.status().relayIp, '192.168.1.40');
  assert.deepEqual(other.published, []);
});

await test('a WSL status change with the same IP does not republish', () => {
  const r = rig({}, { route: 'wsl' });
  const ready: WslRelayStatus = { ...WSL_OFF, enabled: true, state: 'ready', wslIp: '172.28.16.5' };
  r.setWsl(ready);
  r.state.onWslStatus(ready);
  r.state.onWslStatus({ ...ready, state: 'paired' });
  assert.equal(r.published.length, 1);
});

await test('a newer setRoute during the WSL halt wins the mDNS state', async () => {
  let release!: () => void;
  const r = rig({}, { route: 'wsl' });
  const halt = new Promise<void>((res) => (release = res));
  const slow = rig(
    {
      wsl: {
        setEnabled: async (on) => {
          r.log.push(`wsl(${on})`);
          if (!on) await halt;
          return WSL_OFF;
        },
        status: () => WSL_OFF,
      },
      applyMdns: (on) => r.log.push(`mdns(${on})`),
    },
    { route: 'wsl' },
  );
  const first = slow.state.setRoute('none');
  await slow.state.setRoute('device');
  release();
  await first;
  assert.equal(slow.store.current.route, 'device');
  assert.equal(r.log.filter((l) => l.startsWith('mdns')).at(-1), 'mdns(true)');
});

await test('a wsl route where WSL is unsupported keeps mDNS on', async () => {
  const unsupported: WslRelayStatus = { ...WSL_OFF, supported: false };
  const r = rig({
    wsl: { setEnabled: () => Promise.resolve(unsupported), status: () => unsupported },
  });
  await r.state.setRoute('wsl');
  assert.ok(r.log.includes('mdns(false)'));
  assert.ok(!r.log.includes('mdns(true)'));
});

await test('syncPaired publishes only on a change', () => {
  const r = rig();
  r.state.syncPaired();
  assert.deepEqual(r.published, []);
  r.setPaired(true);
  r.state.syncPaired();
  r.state.syncPaired();
  assert.equal(r.published.length, 1);
  assert.equal(r.published[0]!.paired, true);
  r.setPaired(false);
  assert.equal(r.state.status().paired, false, 'status reads the live value');
});

await test('dismiss persists, publishes once and is idempotent', () => {
  const r = rig({}, { route: 'downgrade' });
  assert.equal(r.state.status().wizardDismissed, false);
  const s = r.state.dismiss();
  assert.equal(s.wizardDismissed, true);
  assert.deepEqual(r.store.current, { route: 'downgrade', wizardDismissed: true });
  r.state.dismiss();
  assert.equal(r.published.length, 1);
});

const EV = { stage: 'running', platform: 'linux-arm64', version: '0.23.0' } as const;

await test('a script route gets a token once and keeps it across route changes', async () => {
  const r = rig();
  await r.state.setRoute('device');
  const token = r.store.current.token;
  assert.ok(/^[0-9a-f]{32}$/.test(token ?? ''));
  assert.equal(r.state.scriptToken(), token);
  await r.state.setRoute('downgrade');
  assert.equal(r.state.scriptToken(), null, 'inactive route: no token served');
  await r.state.setRoute('orbstack');
  assert.equal(r.store.current.token, token);
});

await test('start gives a saved script route without a token one', async () => {
  const r = rig({}, { route: 'orbstack' });
  await r.state.start();
  assert.ok(/^[0-9a-f]{32}$/.test(r.store.current.token ?? ''));
});

await test('a relay event sets relayIp, version and progress and is published', async () => {
  const r = rig();
  await r.state.setRoute('device');
  r.published.length = 0;
  r.state.onRelayEvent({ ...EV, stage: 'downloading' }, '192.168.1.50');
  const s = r.published.at(-1)!;
  assert.equal(s.relayIp, '192.168.1.50');
  assert.equal(s.relay?.stage, 'downloading');
  assert.equal(s.relayVersion, '0.23.0');
  assert.equal(s.versionMismatch, false);
  assert.equal(s.announcedAt, r.clock.t);
  assert.equal(r.store.current.relayIp, '192.168.1.50', 'persisted for the Settings row');
  r.state.onRelayEvent({ ...EV, version: 'v0.22.0' }, '192.168.1.50');
  assert.equal(r.published.at(-1)!.versionMismatch, true);
  r.state.stop();
});

await test('an OrbStack relay shows its own IP (NAT hides it), other routes the peer', async () => {
  const r = rig();
  await r.state.setRoute('orbstack');
  r.state.onRelayEvent({ ...EV, selfIp: '192.168.139.155' }, '192.168.2.212');
  assert.equal(r.state.status().relayIp, '192.168.139.155');
  assert.equal(r.state.status().relay?.ip, '192.168.2.212', 'progress keeps the socket peer');
  assert.equal(r.store.current.relayIp, '192.168.139.155');
  await r.state.setRoute('device');
  r.state.onRelayEvent({ ...EV, selfIp: '172.17.0.1' }, '192.168.1.50');
  assert.equal(r.state.status().relayIp, '192.168.1.50');
  r.state.stop();
});

await test('relay events are ignored unless a script route is on', async () => {
  const r = rig();
  r.state.onRelayEvent(EV, '192.168.1.50');
  await r.state.setRoute('downgrade');
  r.state.onRelayEvent(EV, '192.168.1.50');
  assert.equal(r.state.status().relay, null);
});

await test('a silent running relay is offline, a stalled install failed; an event revives it', async () => {
  const r = rig();
  await r.state.setRoute('device');
  r.state.onRelayEvent(EV, '192.168.1.50');
  r.clock.t += 89_000;
  assert.equal(r.state.status().relay?.stage, 'running');
  r.clock.t += 2_000;
  assert.equal(r.state.status().relay?.stage, 'offline');
  r.state.onRelayEvent(EV, '192.168.1.50');
  assert.equal(r.state.status().relay?.stage, 'running');
  r.state.onRelayEvent({ ...EV, stage: 'installing' }, '192.168.1.50');
  r.clock.t += 121_000;
  const s = r.state.status().relay;
  assert.equal(s?.stage, 'failed');
  assert.equal(s?.message, 'No progress');
  r.state.stop();
});

await test('a route change clears the relay progress and the stored relay IP', async () => {
  const r = rig();
  await r.state.setRoute('device');
  r.state.onRelayEvent(EV, '192.168.1.50');
  await r.state.setRoute('orbstack');
  assert.equal(r.state.status().relay, null);
  assert.equal(r.state.status().relayIp, null);
  r.state.stop();
});

await test('the token is in no status, broadcast or settings snapshot', async () => {
  const r = rig();
  await r.state.setRoute('device');
  r.state.onRelayEvent(EV, '192.168.1.50');
  const token = r.store.current.token!;
  assert.ok(!JSON.stringify(r.state.status()).includes(token));
  assert.ok(!JSON.stringify(r.published).includes(token));
  const snap = new PersistedSettings(`${tjs.tmpDir}/pairing-route-tok-${tjs.pid}`);
  snap.setPairingRoute({ route: 'device', token });
  assert.ok(!snap.json().includes(token));
  r.state.stop();
});

await test('supported:false never spawns, reads the version or persists', async () => {
  const r = rig({ supported: false }, { route: 'wsl' });
  await r.state.start();
  r.state.applyPersistedMdns();
  r.state.syncPaired();
  await r.state.setRoute('device');
  r.state.dismiss();
  r.state.onWslStatus(WSL_OFF);
  assert.deepEqual(r.log, []);
  assert.deepEqual(r.published, []);
  assert.equal(r.state.status().supported, false);
  assert.equal(r.store.current.route, 'wsl');
});

// HTTP surface (POSTs carry a body: tjs fetch hangs the next request after an empty-body POST): the controller without a port, then with a counting fake.
const ROOT = `${tjs.tmpDir}/pairing-route-test-${tjs.pid}`;
const ui = new WebUIServer(13478, [], 'real', new PersistedSettings(ROOT));
await ui.start();
const base = `http://127.0.0.1:${ui.port}`;
const post = (path: string, body: string): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

try {
  await test('without a port: unsupported status, empty probe, no-op writes', async () => {
    const s = (await (await fetch(`${base}/api/pairing-route`)).json()) as PairingRouteStatus;
    assert.equal(s.supported, false);
    assert.equal(s.route, 'none');
    const p = (await (await fetch(`${base}/api/pairing-route/probe`)).json()) as PairingProbe;
    assert.equal(p.platform, 'other');
    const set = await post('/api/pairing-route', '{"route":"wsl"}');
    assert.equal(((await set.json()) as PairingRouteStatus).route, 'none');
    const dismissed = await post('/api/pairing-route/dismiss', '{}');
    assert.equal(((await dismissed.json()) as PairingRouteStatus).wizardDismissed, false);
  });

  let probes = 0;
  const calls: string[] = [];
  const fake = rig();
  ui.pairingRoute.attach({
    status: () => fake.state.status(),
    setRoute: (r) => {
      calls.push(r);
      return fake.state.setRoute(r);
    },
    dismiss: () => fake.state.dismiss(),
    command: () => Promise.resolve(null),
    probe: () => {
      probes++;
      return Promise.resolve({
        platform: 'Windows',
        lanIp: '192.168.1.20',
        coraPort: 5343,
        webuiPort: 3000,
        relayScriptPort: 44661,
        lanReachable: true,
        wsl: { installed: false, distros: [] },
        mac: null,
      } satisfies PairingProbe);
    },
  });

  await test('POST route validates the union: anything else is a 400', async () => {
    for (const body of [
      '{}',
      '{"route":"bogus"}',
      '{"route":1}',
      '{"route":"__proto__"}',
      'null',
      'x',
    ]) {
      assert.equal((await post('/api/pairing-route', body)).status, 400, body);
    }
    assert.deepEqual(calls, []);
  });

  await test('POST route sets it and GET reads it back', async () => {
    const res = await post('/api/pairing-route', '{"route":"downgrade"}');
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as PairingRouteStatus).route, 'downgrade');
    const got = (await (await fetch(`${base}/api/pairing-route`)).json()) as PairingRouteStatus;
    assert.equal(got.route, 'downgrade');
    assert.deepEqual(calls, ['downgrade']);
  });

  await test('POST dismiss persists the flag', async () => {
    const res = await post('/api/pairing-route/dismiss', '{}');
    assert.equal(((await res.json()) as PairingRouteStatus).wizardDismissed, true);
  });

  await test('the probe is cached between calls', async () => {
    await (await fetch(`${base}/api/pairing-route/probe`)).json();
    const p = (await (await fetch(`${base}/api/pairing-route/probe`)).json()) as PairingProbe;
    assert.equal(p.lanIp, '192.168.1.20');
    assert.equal(probes, 1);
  });
} finally {
  await ui.stop();
  await tjs.remove(ROOT).catch(() => undefined);
}

summaryExit();
