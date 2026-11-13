/* eslint-disable sonarjs/no-hardcoded-ip -- fixture addresses, nothing is contacted */
import assert from 'tjs:assert';
import { EventEmitter } from 'node:events';
import { pickWslRunner, wireWslRelay } from '../src/main/wsl-relay-wiring.js';
import { PersistedSettings } from '../src/infra/settings.js';
import { WebUIServer } from '../src/web/server/web-ui-server.js';
import type { WslRelayStatus } from '../src/web/contract-wsl-relay.js';
import { testAsync as test, summaryExit } from './helpers/harness.js';

console.log('\nwsl-relay wiring');

const ROOT = `${tjs.tmpDir}/wsl-relay-wiring-test-${tjs.pid}`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

await test('runner choice: mock scenario anywhere, real on Windows, else none', () => {
  assert.ok(pickWslRunner({ DECKBRIDGE_WSL_RELAY_MOCK: 'happy' }, 'Darwin') !== null);
  assert.ok(pickWslRunner({}, 'Windows') !== null);
  assert.equal(pickWslRunner({}, 'Darwin'), null);
  assert.equal(pickWslRunner({ DECKBRIDGE_WSL_RELAY_MOCK: 'bogus' }, 'Linux'), null);
});

function rig(dir: string, enabled: boolean) {
  const settings = new PersistedSettings(`${ROOT}/${dir}`);
  settings.setWslRelay({ enabled });
  const webui = new WebUIServer(undefined, [], 'real', settings);
  const mdns: boolean[] = [];
  const primaryDock = {
    server: { setMdnsEnabled: (on: boolean) => mdns.push(on) },
    childHasClient: false,
  };
  const driverManager = new EventEmitter();
  const wired = wireWslRelay(
    { webui, settings, driverManager, primaryDock } as unknown as Parameters<
      typeof wireWslRelay
    >[0],
    () => '192.168.1.10',
  );
  return { webui, mdns, wired, primaryDock, driverManager };
}

async function until(webui: WebUIServer, state: WslRelayStatus['state']): Promise<void> {
  for (let i = 0; i < 100 && webui.wslRelay.status().state !== state; i++) await sleep(100);
  assert.equal(webui.wslRelay.status().state, state);
}

await test('unsupported system: start() touches neither mDNS nor the relay', async () => {
  tjs.env.DECKBRIDGE_WSL_RELAY_MOCK = '';
  const r = rig('off', true);
  if (r.webui.wslRelay.status().supported) return; // Windows host: the real runner would run
  r.wired.start();
  await sleep(50);
  assert.deepEqual(r.mdns, []);
  assert.equal(r.webui.wslRelay.status().state, 'off');
});

await test('autostart: mDNS off, ready via the mock runner, paired follows the dock, stop() => off', async () => {
  tjs.env.DECKBRIDGE_WSL_RELAY_MOCK = 'happy';
  try {
    const r = rig('on', true);
    assert.equal(r.webui.wslRelay.status().supported, true);
    assert.deepEqual(
      r.mdns,
      [false],
      'a persisted switch silences mDNS before the CORA servers start',
    );
    const dock: boolean[] = [];
    r.wired.trackMdns({ setMdnsEnabled: (on) => dock.push(on) });
    assert.deepEqual(dock, [false], 'a dock created later is silenced too');
    r.wired.start();
    assert.deepEqual(r.mdns, [false]);
    await until(r.webui, 'ready');
    assert.equal(r.webui.wslRelay.status().wslIp, '172.28.16.5');
    r.primaryDock.childHasClient = true;
    r.driverManager.emit('changed');
    assert.equal(r.webui.wslRelay.status().state, 'paired');
    await r.wired.stop();
    assert.equal(r.webui.wslRelay.status().state, 'off');
    assert.equal(r.webui.wslRelay.status().enabled, true, 'shutdown keeps the switch');
  } finally {
    tjs.env.DECKBRIDGE_WSL_RELAY_MOCK = '';
  }
});

await test('disabling through the controller turns mDNS back on', async () => {
  tjs.env.DECKBRIDGE_WSL_RELAY_MOCK = 'happy';
  try {
    const r = rig('toggle', false);
    await r.webui.wslRelay.setEnabled(true);
    assert.equal(r.webui.wslRelay.status().state, 'checking');
    await r.webui.wslRelay.setEnabled(false);
    assert.deepEqual(r.mdns, [false, true]);
    const dock: boolean[] = [];
    r.wired.trackMdns({ setMdnsEnabled: (on) => dock.push(on) });
    assert.deepEqual(dock, [], 'a relay that is off leaves a new dock advertising');
    assert.equal(r.webui.wslRelay.status().state, 'off');
    assert.equal(r.webui.settings.wslRelay.enabled, false);
  } finally {
    tjs.env.DECKBRIDGE_WSL_RELAY_MOCK = '';
  }
});

await tjs.remove(ROOT).catch(() => undefined);
summaryExit();
