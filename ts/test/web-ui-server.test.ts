import assert from 'tjs:assert';
import {
  isAllowedWebRequest,
  isValidMacAddress,
  pickFallbackPort,
  WebUIServer,
} from '../src/web/server/web-ui-server.js';
import { docsUrl, docsTrackingAllowed } from '../src/web/server/docs-links.js';
import { Broadcaster } from '../src/web/server/broadcaster.js';
import { OWN_IP_CACHE_TTL_MS, resetOwnIpCache } from '../src/web/server/web-request-guard.js';
import { saveSettings } from '../src/infra/settings-store.js';
import type { Settings } from '../src/infra/settings-store.js';
import type { DockStatus } from '../src/shared/types.js';
import type { StatusSnapshot } from '../src/web/contract.js';
import { test, testAsync as runWebTest, summaryExit } from './helpers/harness.js';
import { PersistedSettings } from '../src/infra/settings.js';
import { DEFAULT_STANDBY, publicStandby } from '../src/shared/standby-settings.js';
import type { StandbyView } from '../src/web/contract-standby.js';

/** WebUIServer over settings loaded from `root`, as app.ts loads them before construction. */
async function webUIAt(root: string, port?: number): Promise<WebUIServer> {
  const settings = new PersistedSettings(root);
  await settings.load();
  return new WebUIServer(port, [], 'real', settings);
}

// Isolate settings.json writes from the real user cache dir — every mutator
// that touches a persisted field now writes to disk (see settings-store.ts).
const TEST_SETTINGS_ROOT = `${tjs.tmpDir}/webui-server-test-settings-${tjs.pid}`;

// isValidMacAddress

console.log('\nisValidMacAddress');

test('valid lowercase hex MAC → true', () => {
  assert.ok(isValidMacAddress('aa:bb:cc:dd:ee:ff'));
});

test('valid uppercase hex MAC → true', () => {
  assert.ok(isValidMacAddress('AA:BB:CC:DD:EE:FF'));
});

test('valid mixed-case hex MAC → true', () => {
  assert.ok(isValidMacAddress('aA:bB:cC:dD:eE:fF'));
});

test('valid all-zeros MAC → true', () => {
  assert.ok(isValidMacAddress('00:00:00:00:00:00'));
});

test('too few octets → false', () => {
  assert.ok(!isValidMacAddress('aa:bb:cc:dd:ee'));
});

test('too many octets → false', () => {
  assert.ok(!isValidMacAddress('aa:bb:cc:dd:ee:ff:00'));
});

test('non-hex character → false', () => {
  assert.ok(!isValidMacAddress('gg:bb:cc:dd:ee:ff'));
});

test('hyphen separator → false', () => {
  assert.ok(!isValidMacAddress('aa-bb-cc-dd-ee-ff'));
});

test('octet too long → false', () => {
  assert.ok(!isValidMacAddress('aaa:bb:cc:dd:ee:ff'));
});

test('octet too short → false', () => {
  assert.ok(!isValidMacAddress('a:bb:cc:dd:ee:ff'));
});

test('empty string → false', () => {
  assert.ok(!isValidMacAddress(''));
});

// isAllowedWebRequest

console.log('\nisAllowedWebRequest');

test('localhost host, no origin → true', () => {
  assert.ok(isAllowedWebRequest('localhost:3000', null, 3000));
});

test('127.0.0.1 host, localhost origin → true', () => {
  assert.ok(isAllowedWebRequest('127.0.0.1:3000', 'http://localhost:3000', 3000));
});

test('[::1] host, no origin → true', () => {
  assert.ok(isAllowedWebRequest('[::1]:3000', null, 3000));
});

test('mixed-case host → true', () => {
  assert.ok(isAllowedWebRequest('LocalHost:3000', null, 3000));
});

test('null host → false', () => {
  assert.ok(!isAllowedWebRequest(null, null, 3000));
});

test('DNS-rebinding host → false', () => {
  assert.ok(!isAllowedWebRequest('evil.example:3000', null, 3000));
});

test('wrong port in host → false', () => {
  assert.ok(!isAllowedWebRequest('localhost:9999', null, 3000));
});

test('cross-site origin → false', () => {
  assert.ok(!isAllowedWebRequest('localhost:3000', 'https://evil.example', 3000));
});

test('wrong-port origin → false', () => {
  assert.ok(!isAllowedWebRequest('localhost:3000', 'http://localhost:4000', 3000));
});

test('bare host (no port), no origin → true', () => {
  assert.ok(isAllowedWebRequest('127.0.0.1', null, 3000));
});

test('bare host, bare origin → true', () => {
  assert.ok(isAllowedWebRequest('127.0.0.1', 'http://127.0.0.1', 3000));
});

// isAllowedWebRequest — own-interface IP literals (--bind 0.0.0.0 LAN access) ─

console.log('\nisAllowedWebRequest — own-interface IP literals');

const ownIp = tjs.system.networkInterfaces.find(
  (i) => !i.internal && !i.address.includes(':'),
)?.address;

test('this machine’s own non-internal IPv4 as Host → true', () => {
  if (!ownIp) {
    console.log('  (skipped: no non-internal IPv4 interface on this machine)');
    return;
  }
  assert.ok(isAllowedWebRequest(`${ownIp}:3000`, null, 3000));
});

test('own IP, matching origin → true', () => {
  if (!ownIp) {
    console.log('  (skipped: no non-internal IPv4 interface on this machine)');
    return;
  }
  assert.ok(isAllowedWebRequest(`${ownIp}:3000`, `http://${ownIp}:3000`, 3000));
});

test('own IP with wrong port → false', () => {
  if (!ownIp) {
    console.log('  (skipped: no non-internal IPv4 interface on this machine)');
    return;
  }
  assert.ok(!isAllowedWebRequest(`${ownIp}:9999`, null, 3000));
});

test('foreign IP literal (TEST-NET-3, never a real interface) → false', () => {
  assert.ok(!isAllowedWebRequest('203.0.113.5:3000', null, 3000));
});

test('DNS-rebinding domain still rejected (own-IP addition does not allow-any-Host)', () => {
  assert.ok(!isAllowedWebRequest('evil.example:3000', null, 3000));
});

test('the own-IP cache survives its TTL: still allowed after the refresh', () => {
  if (!ownIp) return;
  resetOwnIpCache();
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => t;
  try {
    assert.ok(isAllowedWebRequest(`${ownIp}:3000`, null, 3000), 'primes the cache');
    t += OWN_IP_CACHE_TTL_MS + 1; // next call rebuilds it from the live interface list
    assert.ok(isAllowedWebRequest(`${ownIp}:3000`, null, 3000));
    assert.ok(!isAllowedWebRequest('203.0.113.5:3000', null, 3000));
  } finally {
    Date.now = realNow;
  }
});

test('localhost/127.0.0.1/[::1] still allowed alongside own-IP support', () => {
  assert.ok(isAllowedWebRequest('localhost:3000', null, 3000));
  assert.ok(isAllowedWebRequest('127.0.0.1:3000', null, 3000));
  assert.ok(isAllowedWebRequest('[::1]:3000', null, 3000));
});

// pickFallbackPort

console.log('\npickFallbackPort');

test('returns a port in the expected fallback range', () => {
  for (let i = 0; i < 50; i++) {
    const port = pickFallbackPort();
    assert.ok(port >= 64000 && port <= 65000, `port ${port} out of range`);
  }
});

// Broadcaster.size

console.log('\nBroadcaster.size');

function mockSocket(): ServerWebSocket {
  return {
    data: undefined,
    sendText: () => {},
    sendBinary: () => {},
    close: () => {},
  };
}

test('starts at 0 with no clients', () => {
  const bus = new Broadcaster();
  assert.equal(bus.size, 0);
});

test('increments on open, decrements on close', () => {
  const bus = new Broadcaster();
  const handlers = bus.websocketHandlers(() => {});
  const ws1 = mockSocket();
  const ws2 = mockSocket();

  handlers.open(ws1);
  assert.equal(bus.size, 1);

  handlers.open(ws2);
  assert.equal(bus.size, 2);

  handlers.close(ws1);
  assert.equal(bus.size, 1);

  handlers.close(ws2);
  assert.equal(bus.size, 0);
});

test('decrements on error', () => {
  const bus = new Broadcaster();
  const handlers = bus.websocketHandlers(() => {});
  const ws = mockSocket();

  handlers.open(ws);
  assert.equal(bus.size, 1);

  handlers.error(ws);
  assert.equal(bus.size, 0);
});

test('stop() clears all clients', () => {
  const bus = new Broadcaster();
  const handlers = bus.websocketHandlers(() => {});
  handlers.open(mockSocket());
  handlers.open(mockSocket());
  assert.equal(bus.size, 2);

  bus.stop();
  assert.equal(bus.size, 0);
});

// WebUIServer.resetImages

console.log('\nWebUIServer.resetImages');

test('drops the selected dock frames and broadcasts imagesReset', () => {
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
  ui.notifyDockImage(0, 0, Buffer.from([1, 2, 3]));
  ui.notifyDockImage(0, 1, Buffer.from([4, 5, 6]));
  assert.equal(ui.imageChannel.selectedImages().size, 2, 'two images set');

  const { sent } = connectMockClient(ui);
  sent.length = 0;
  ui.resetImages();

  assert.equal(ui.imageChannel.selectedImages().size, 0, 'frames dropped');
  const events = sent.map((m) => (JSON.parse(m) as { event: string }).event);
  assert.ok(events.includes('imagesReset'), 'imagesReset broadcast sent');
});

// WebUIServer.notifyDocks

console.log('\nWebUIServer.notifyDocks');

function fakeDockStatus(index: number): DockStatus {
  return {
    index,
    modelId: 'mk2',
    modelName: 'Stream Deck MK.2',
    keyCount: 15,
    columns: 5,
    rows: 3,
    primaryPort: 5343 + index * 2,
    primaryConnected: true,
    elgatoConnected: true,
    brightness: 100,
    dockFirmwareVersion: '1.01.016',
    childFirmwareVersion: '1.01.000',
    serialNumber: `A7FZA519${index}ILSAA`,
    childSerialNumber: `A7FZA519${index}ILSNQ`,
    productId: 0x0080,
    macAddress: '02:00:00:00:00:01',
    mdnsServiceName: 'Network Stream Deck',
    deviceKey: `fake-device-${index}`,
  };
}

function connectMockClient(ui: WebUIServer): { sent: string[] } {
  const bus = (ui as unknown as { bus: Broadcaster }).bus;
  const sent: string[] = [];
  const ws: ServerWebSocket = {
    data: undefined,
    sendText: (msg: string) => {
      sent.push(msg);
    },
    sendBinary: () => {},
    close: () => {},
  };
  // Mirrors the onOpen wiring WebUIServer.start() installs on the real server:
  // a freshly connected client gets an immediate 'status' snapshot.
  const handlers = bus.websocketHandlers((sock) => {
    bus.sendTo(sock, 'status', (ui as unknown as { snapshot(): StatusSnapshot }).snapshot());
  });
  handlers.open(ws);
  return { sent };
}

test('snapshot.docks defaults to empty array', () => {
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
  assert.deepEqual(ui.fullState().docks, []);
});

test('fullState exposes selected dock real device identity', () => {
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
  const realDeviceIdentity = {
    modelName: 'Stream Deck MK.2',
    serialNumber: 'REAL123',
    firmwareVersion: '2.0.1',
  };

  ui.notifyDocks([{ ...fakeDockStatus(0), realDeviceIdentity }]);

  assert.deepEqual(ui.fullState().realDeviceIdentity, realDeviceIdentity);
});

/** What broadcastSelected() pushes for the selected dock, in order. */
const SELECTED_DEVICE_EVENTS = [
  'brightnessOverride',
  'extraKeys',
  'touchStripMode',
  'touchStripRepaint',
  'encoders',
  'pages',
  'pageState',
];

test('notifyDocks broadcasts status + selected-device state to a connected WS client', () => {
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
  const { sent } = connectMockClient(ui);
  sent.length = 0; // discard the initial-connect snapshot

  ui.notifyDocks([fakeDockStatus(0)]);

  // The selected dock's live deviceKey may have changed, so notifyDocks re-pushes
  // its per-device values (extra keys, touch strip, …) alongside the status snapshot.
  const events = sent.map((m) => (JSON.parse(m) as { event: string }).event);
  assert.deepEqual(events, ['status', ...SELECTED_DEVICE_EVENTS]);
  const parsed = JSON.parse(sent[0]!) as { event: string; data: { docks: DockStatus[] } };
  assert.equal(parsed.data.docks.length, 1);
  assert.equal(parsed.data.docks[0]!.index, 0);
});

test('duplicate notifyDocks call (same shape) does not broadcast again', () => {
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
  const { sent } = connectMockClient(ui);
  sent.length = 0;

  ui.notifyDocks([fakeDockStatus(0)]);
  const perCall = 1 + SELECTED_DEVICE_EVENTS.length;
  assert.equal(sent.length, perCall, 'first call broadcasts status + selected-device state');

  ui.notifyDocks([fakeDockStatus(0)]); // new array, same JSON shape
  assert.equal(sent.length, perCall, 'duplicate call is deduped — no further broadcast');

  ui.notifyDocks([fakeDockStatus(0), fakeDockStatus(1)]);
  assert.equal(sent.length, 2 * perCall, 'a genuinely different list broadcasts again');
});

const STRIP = [
  {
    wireId: 1,
    label: 'Left',
    width: 176,
    height: 112,
    stripX: 0,
    rotate: 180 as const,
    flipH: false,
    flipV: false,
  },
];

test('touch-strip mode: 409 without a strip, else persist + broadcast + touchStripModeChanged', () => {
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
  ui.notifyDocks([fakeDockStatus(0)]);
  assert.equal(
    ui.devicePrefs.trySetTouchStripMode('deckbridge-ignore')?.status,
    409,
    'MK.2 has no strip',
  );
  assert.equal(
    ui.settings.for('fake-device-0').stripMode(),
    'elgato',
    'default is Elgato app only',
  );

  ui.settings.getOrCreateIdentity('fake-device-0', 'Dock');
  ui.notifyDocks([{ ...fakeDockStatus(0), widgetDisplays: STRIP }]);
  const { sent } = connectMockClient(ui);
  sent.length = 0;
  const changed: unknown[][] = [];
  ui.on('touchStripModeChanged', (...args: unknown[]) => changed.push(args));

  assert.equal(ui.devicePrefs.trySetTouchStripMode('deckbridge-repaint'), null);
  assert.deepEqual(changed, [[0, 'deckbridge-repaint']]);
  assert.deepEqual(JSON.parse(sent[0]!), {
    event: 'touchStripMode',
    data: { mode: 'deckbridge-repaint' },
  });
  assert.equal(ui.settings.for('fake-device-0').stripMode(), 'deckbridge-repaint');
  assert.equal(ui.fullState().touchStripMode, 'deckbridge-repaint');
  const saved = JSON.parse(ui.settings.json()) as { devices: { touchStripMode?: string }[] };
  assert.equal(saved.devices[0]!.touchStripMode, 'deckbridge-repaint', 'persisted per device');
});

test('touch-strip repaint interval: 409 without a strip, default 5 s, else persist + broadcast', () => {
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
  ui.notifyDocks([fakeDockStatus(0)]);
  assert.equal(ui.devicePrefs.trySetTouchStripRepaintMs(2000)?.status, 409, 'MK.2 has no strip');
  assert.equal(ui.settings.for('fake-device-0').repaintMs(), 5000, 'default is 5 s');

  ui.settings.getOrCreateIdentity('fake-device-0', 'Dock');
  ui.notifyDocks([{ ...fakeDockStatus(0), widgetDisplays: STRIP }]);
  const { sent } = connectMockClient(ui);
  sent.length = 0;

  assert.equal(ui.devicePrefs.trySetTouchStripRepaintMs(2000), null);
  assert.deepEqual(JSON.parse(sent[0]!), { event: 'touchStripRepaint', data: { ms: 2000 } });
  assert.equal(ui.settings.for('fake-device-0').repaintMs(), 2000);
  assert.equal(ui.fullState().touchStripRepaintMs, 2000);
  const saved = JSON.parse(ui.settings.json()) as {
    devices: { touchStripRepaintMs?: number }[];
  };
  assert.equal(saved.devices[0]!.touchStripRepaintMs, 2000, 'persisted per device');
});

test('encoders: 409 without a strip or knobs, 400 past the last knob', () => {
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
  ui.notifyDocks([{ ...fakeDockStatus(0), encoderCount: 4 }]);
  assert.equal(ui.encoders.trySet({ connectToApp: false })?.status, 409, 'no strip');
  ui.notifyDocks([{ ...fakeDockStatus(0), widgetDisplays: STRIP }]);
  assert.equal(ui.encoders.trySet({ connectToApp: false })?.status, 409, 'no knobs');
  ui.notifyDocks([{ ...fakeDockStatus(0), widgetDisplays: STRIP, encoderCount: 2 }]);
  assert.equal(ui.encoders.trySet({ commands: { '2': { press: 'x' } } })?.status, 400);
});

test('encoders: merges per knob, trims blanks, persists and broadcasts', () => {
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
  ui.settings.getOrCreateIdentity('fake-device-0', 'Dock');
  ui.notifyDocks([{ ...fakeDockStatus(0), widgetDisplays: STRIP, encoderCount: 4 }]);
  const { sent } = connectMockClient(ui);
  sent.length = 0;

  assert.equal(ui.encoders.trySet({ connectToApp: false }), null);
  assert.equal(
    ui.encoders.trySet({
      commands: { '0': { press: ' mute ', rotateCw: 'up' }, '1': { press: 'a' } },
    }),
    null,
  );
  assert.equal(ui.encoders.trySet({ commands: { '1': { press: '' } } }), null, 'emptied knob');

  const expected = { connectToApp: false, commands: { '0': { press: 'mute', rotateCw: 'up' } } };
  assert.deepEqual(ui.settings.for('fake-device-0').encoders(), expected);
  assert.deepEqual(ui.fullState().encoders, expected);
  assert.deepEqual(JSON.parse(sent.at(-1)!), { event: 'encoders', data: { encoders: expected } });
  const saved = JSON.parse(ui.settings.json()) as { devices: { encoders?: unknown }[] };
  assert.deepEqual(saved.devices[0]!.encoders, expected, 'persisted per device');
});

test('applySettingsJson: invalid optional settings are stripped while identity survives', () => {
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
  ui.notifyDocks([fakeDockStatus(0)]);
  const entry = (extra: Parameters<typeof deviceEntry>[1]): string =>
    JSON.stringify({ devices: [deviceEntry('fake-device-0', extra)] });
  const stored = (): unknown[] =>
    (JSON.parse(ui.settings.json()) as { devices?: unknown[] }).devices ?? [];

  ui.settingsFile.applyJson(entry({ touchStripMode: 'sometimes' }));
  assert.deepEqual(stored(), [deviceEntry('fake-device-0', {})], 'unknown mode stripped');
  ui.settingsFile.applyJson(entry({ touchStripRepaintMs: 10 }));
  assert.deepEqual(
    stored(),
    [deviceEntry('fake-device-0', {})],
    'invalid repaint interval stripped',
  );
  ui.settingsFile.applyJson(entry({ touchStripZoneFit: 'stretch' }));
  assert.deepEqual(stored(), [deviceEntry('fake-device-0', {})], 'unknown zone fit stripped');
  ui.settingsFile.applyJson(entry({ touchStripUpload: 'never' }));
  assert.deepEqual(stored(), [deviceEntry('fake-device-0', {})], 'unknown upload policy stripped');
  ui.settingsFile.applyJson(entry({ encoders: { commands: { '7': { press: 'x' } } } }));
  assert.deepEqual(stored(), [deviceEntry('fake-device-0', {})], 'out-of-range knob stripped');
  ui.settingsFile.applyJson(entry({ encoders: { commands: { '0': { press: 'x'.repeat(513) } } } }));
  assert.deepEqual(stored(), [deviceEntry('fake-device-0', {})], 'over-long command stripped');

  ui.settingsFile.applyJson(
    entry({ touchStripMode: 'deckbridge-ignore', encoders: { connectToApp: false } }),
  );
  assert.equal(ui.settings.for('fake-device-0').stripMode(), 'deckbridge-ignore');
  assert.deepEqual(ui.settings.for('fake-device-0').encoders(), { connectToApp: false });
  ui.settingsFile.applyJson(entry({ touchStripZoneFit: 'scale', touchStripUpload: 'always' }));
  assert.deepEqual(stored(), [
    deviceEntry('fake-device-0', { touchStripZoneFit: 'scale', touchStripUpload: 'always' }),
  ]);
});

const extraKeyEntry = (extraKeys: unknown): string =>
  JSON.stringify({ devices: [{ ...deviceEntry('fake-device-0', {}), extraKeys }] });

test('extra-key press command: pressable keys only, widget and command replace independently', () => {
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
  ui.settings.getOrCreateIdentity('fake-device-0', 'Dock');
  ui.notifyDocks([{ ...fakeDockStatus(0), extraKeys: [15, 10], pressableExtraKeys: [15] }]);
  const changed: unknown[][] = [];
  ui.on('extraKeyChanged', (...args: unknown[]) => changed.push(args));
  const cfg = () => ui.settings.for('fake-device-0').extraKeyConfig(15);

  assert.equal(ui.extraKeys.trySet(10, { pressCommand: 'x' })?.status, 400, 'no switch');
  assert.equal(ui.extraKeys.trySet(3, { pressCommand: 'x' })?.status, 400, 'no such extra key');
  assert.equal(ui.extraKeys.trySet(15, { pressCommand: ' say hi ' }), null);
  assert.deepEqual(cfg(), { widget: 'none', pressCommand: 'say hi' }, 'trimmed, no widget yet');
  assert.equal(changed.length, 0, 'a press command needs no repaint');

  assert.equal(ui.extraKeys.trySet(15, { widget: 'clock' }), null);
  assert.deepEqual(cfg(), { widget: 'clock', pressCommand: 'say hi' }, 'widget keeps command');
  assert.deepEqual(changed, [[0]]);
  assert.equal(ui.extraKeys.trySet(15, { pressCommand: '' }), null);
  assert.deepEqual(cfg(), { widget: 'clock' }, 'command cleared, widget kept');
  assert.equal(ui.extraKeys.trySet(15, { widget: 'none' }), null);
  assert.equal(cfg(), undefined, 'nothing left → entry dropped');

  assert.equal(ui.extraKeys.trySet(15, { pressAction: 'both' }), null);
  assert.deepEqual(cfg(), { widget: 'none', pressAction: 'both' }, 'an action alone persists');
  assert.equal(ui.extraKeys.trySet(15, { pressCommand: 'go' }), null);
  assert.equal(ui.extraKeys.trySet(15, { widget: 'clock' }), null);
  assert.deepEqual(
    cfg(),
    { widget: 'clock', pressCommand: 'go', pressAction: 'both' },
    'widget change keeps the whole press side',
  );
  assert.equal(ui.extraKeys.trySet(15, { pressAction: 'refresh' }), null);
  assert.deepEqual(cfg(), { widget: 'clock', pressCommand: 'go', pressAction: 'refresh' });
  assert.equal(ui.extraKeys.trySet(10, { pressAction: 'both' })?.status, 400, 'no switch');
  assert.equal(ui.extraKeys.trySet(15, { widget: 'none' }), null);
  assert.equal(ui.extraKeys.trySet(15, { pressCommand: '' }), null);
  assert.deepEqual(cfg(), { widget: 'none', pressAction: 'refresh' });

  ui.settingsFile.applyJson(extraKeyEntry({ '15': { widget: 'none', pressAction: 'always' } }));
  assert.equal(cfg(), undefined, 'invalid optional extraKeys stripped on import');
  assert.ok(ui.settings.entryFor('fake-device-0'), 'device identity survives');
  ui.settingsFile.applyJson(extraKeyEntry({}));
  ui.settingsFile.applyJson(
    extraKeyEntry({ '15': { widget: 'none', pressCommand: 'x'.repeat(513) } }),
  );
  assert.equal(cfg(), undefined, 'over-long press command rejected');
  ui.settingsFile.applyJson(
    extraKeyEntry({ '15': { widget: 'none', pressCommand: 'open -a Music' } }),
  );
  assert.deepEqual(cfg(), { widget: 'none', pressCommand: 'open -a Music' });
});

test('extra-key style is persisted with the widget; preview needs a paint', () => {
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
  ui.settings.getOrCreateIdentity('fake-device-0', 'Dock');
  ui.notifyDocks([{ ...fakeDockStatus(0), extraKeys: [15] }]);
  const cfg = () => ui.settings.for('fake-device-0').extraKeyConfig(15);

  const style = { textSize: 'fit' as const };
  assert.equal(ui.extraKeys.trySet(15, { widget: 'text', param: 'Hello', style }), null);
  assert.deepEqual(cfg(), { widget: 'text', param: 'Hello', style });

  const none = ui.extraKeys.tryPreview(15);
  assert.ok('error' in none && none.status === 404, 'nothing painted yet');
  assert.ok('error' in ui.extraKeys.tryPreview(3), 'not a key on this dock');
  ui.imageChannel.notifyDockWidgetPaint(0, 15, {
    bmp: new Uint8Array(),
    lines: [{ text: 'Hello', big: true }],
    width: 85,
    height: 85,
    clipped: false,
    style: {},
    zone: false,
  });
  const res = ui.extraKeys.tryPreview(15);
  if ('error' in res) throw new Error(res.error);
  assert.equal(res.wireId, 15);
  assert.equal(res.previews.length, 6);
});

test("new WS client's initial snapshot carries stored docks", () => {
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
  ui.notifyDocks([fakeDockStatus(0), fakeDockStatus(1)]);

  const { sent } = connectMockClient(ui);

  assert.equal(sent.length, 1, 'initial snapshot sent on connect');
  const parsed = JSON.parse(sent[0]!) as { event: string; data: { docks: DockStatus[] } };
  assert.equal(parsed.event, 'status');
  assert.equal(parsed.data.docks.length, 2);
});

// WebUIServer selected-dock preview mirror

console.log('\nWebUIServer selected-dock preview mirror');

test('notifyDockImage broadcasts only the selected dock, caches the rest', () => {
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
  const { sent } = connectMockClient(ui);
  sent.length = 0;

  ui.notifyDockImage(0, 3, Buffer.from([1, 2, 3]), 'jpeg');
  assert.equal(sent.length, 1, 'selected dock (0) broadcasts an image');
  assert.equal((JSON.parse(sent[0]!) as { event: string }).event, 'image');
  assert.ok(ui.imageChannel.selectedImages().has(3), 'selected dock frame cached');

  ui.notifyDockImage(1, 5, Buffer.from([9, 9]), 'jpeg');
  assert.equal(sent.length, 1, 'unselected dock does not broadcast');
  assert.ok(!ui.imageChannel.selectedImages().has(5), 'unselected dock frame not shown');
});

test('selectDock swaps the channel and replays the cached frames', () => {
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
  ui.notifyDocks([fakeDockStatus(0), fakeDockStatus(1)]);
  ui.notifyDockImage(0, 0, Buffer.from([1]), 'jpeg');
  ui.notifyDockImage(1, 2, Buffer.from([7, 7]), 'bmp');

  const { sent } = connectMockClient(ui);
  sent.length = 0;

  ui.selectDock(1);

  const events = sent.map((m) => (JSON.parse(m) as { event: string }).event);
  assert.deepEqual(events[0], 'status', 'status broadcast first (selectedDock change)');
  assert.ok(events.includes('image'), "the new dock's cached frames are replayed");
  assert.ok(!ui.imageChannel.selectedImages().has(0), "old dock's frames no longer shown");
  assert.ok(ui.imageChannel.selectedImages().has(2), "new dock's frames now shown");
  assert.equal(ui.snapshot().selectedDock, 1);
  const replayed = sent
    .map((m) => JSON.parse(m) as { event: string; data: { format?: string } })
    .find((m) => m.event === 'image');
  assert.equal(replayed?.data.format, 'bmp', 'replay keeps the frame format');
});

test('touch-strip frames: full resets, a window replaces its own region, snapshot in order', () => {
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
  ui.notifyDocks([fakeDockStatus(0), fakeDockStatus(1)]);
  const touch = ui.imageChannel;
  const a = { x: 0, y: 0, w: 200, h: 100 };
  touch.notifyDockTouchImage(0, new Uint8Array([1]));
  touch.notifyDockTouchImage(0, new Uint8Array([2]), a);
  touch.notifyDockTouchImage(0, new Uint8Array([3]), { x: 200, y: 0, w: 200, h: 100 });
  touch.notifyDockTouchImage(0, new Uint8Array([4]), a);
  touch.notifyDockTouchImage(1, new Uint8Array([9]));

  const { sent } = connectMockClient(ui);
  sent.length = 0;
  touch.sendSnapshot(
    (ui as unknown as { bus: { clients: Set<ServerWebSocket> } }).bus.clients.values().next()
      .value!,
  );
  const events = sent.map((m) => JSON.parse(m) as { event: string; data: { data: string } });
  const frames = events.filter((f) => f.event === 'touchImage');
  assert.deepEqual(
    frames.map((f) => [...Buffer.from(f.data.data, 'base64')][0]),
    [1, 3, 4],
    'full frame, then windows in paint order; the repainted window moved last',
  );
  assert.deepEqual(
    events.filter((f) => f.event !== 'touchImage'),
    [{ event: 'stripWrite', data: { clear: true } }],
    'the device-strip mirror only resets (nothing written yet)',
  );

  sent.length = 0;
  touch.notifyDockTouchImage(0, new Uint8Array([5]));
  touch.notifyDockTouchImage(1, new Uint8Array([6]));
  assert.equal(sent.length, 1, 'only the selected dock broadcasts');
});

test('selecting an unknown/removed dock is rejected; unplug falls back to 0', () => {
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
  ui.notifyDocks([fakeDockStatus(0), fakeDockStatus(1)]);

  assert.equal(ui.trySelectDock(7)?.status, 404, 'unknown dock index rejected');
  assert.equal(ui.trySelectDock(-1)?.status, 400, 'negative index rejected');
  assert.equal(ui.trySelectDock('x')?.status, 400, 'non-number rejected');

  assert.equal(ui.trySelectDock(1), null, 'live dock accepted');
  assert.equal(ui.snapshot().selectedDock, 1);

  ui.notifyDocks([fakeDockStatus(0)]); // dock 1 unplugged
  assert.equal(ui.snapshot().selectedDock, 0, 'selection falls back to the primary');
});

test('selectDock: snapshot brightness follows the selected dock (per-device)', () => {
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
  ui.notifyDocks([
    { ...fakeDockStatus(0), brightness: 22 },
    { ...fakeDockStatus(1), brightness: 65 },
  ]);
  assert.equal(ui.snapshot().brightness, 22, 'primary selected initially → its brightness');

  ui.selectDock(1);
  assert.equal(
    ui.snapshot().brightness,
    65,
    "switching to dock 1 shows its own brightness, not dock 0's",
  );
});

// WebUIServer.applyMockConfig productId

console.log('\nWebUIServer.applyMockConfig productId');

test('NaN productId leaves previous PID unchanged', () => {
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
  const before = ui.fullState().mockConfig!.productId;
  const result = ui.applyMockConfig({ productId: Number.NaN });
  assert.equal(result.productId, before, 'productId unchanged for NaN');
});

test('valid integer productId is masked and applied', () => {
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
  const result = ui.applyMockConfig({ productId: 0x1234abcd });
  assert.equal(result.productId, 0x1234abcd & 0xffff, 'productId masked');
});

// WebUIServer: misc validation-only routes (touch-strip-mode, touch-strip-repaint,
// encoders, extra-key/press, removed touch-strip)

console.log('\nwebui: misc route validation');

const ROUTES_TEST_PORT = 13002;
const routesUi = await webUIAt(TEST_SETTINGS_ROOT, ROUTES_TEST_PORT);
await routesUi.start();

try {
  const base = `http://127.0.0.1:${routesUi.port}`;

  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  await runWebTest(
    'GET /api/elgato-app/status reads process state without controlling the app',
    async () => {
      const control = routesUi.elgatoApp.control;
      const original = {
        isRunning: control.isRunning.bind(control),
        restart: control.restart.bind(control),
        launch: control.launch.bind(control),
      };
      let running = false;
      let launches = 0;
      let restarts = 0;
      control.isRunning = () => Promise.resolve(running);
      control.launch = () => {
        launches++;
        return Promise.resolve(true);
      };
      control.restart = () => {
        restarts++;
        return Promise.resolve({ ok: true, killed: false });
      };
      try {
        for (const value of [false, true]) {
          running = value;
          const response = await fetch(`${base}/api/elgato-app/status`);
          assert.equal(response.status, 200);
          assert.equal(((await response.json()) as { running: boolean }).running, value);
        }
        assert.equal(launches, 0);
        assert.equal(restarts, 0);
        await post('/api/elgato-app/restart', {});
        assert.equal(restarts, 1, 'a running process is restarted');
        running = false;
        await post('/api/elgato-app/restart', {});
        assert.equal(launches, 1, 'a stopped process is launched');
      } finally {
        Object.assign(control, original);
      }
    },
  );

  await runWebTest(
    'POST /api/touch-strip-mode: unknown mode → 400, valid mode on MK.2 → 409',
    async () => {
      assert.equal((await post('/api/touch-strip-mode', { mode: 'sometimes' })).status, 400);
      assert.equal((await post('/api/touch-strip-mode', { mode: 'elgato' })).status, 409);
    },
  );

  await runWebTest(
    'POST /api/touch-strip-repaint: out-of-range or non-integer ms → 400, valid ms on MK.2 → 409',
    async () => {
      for (const ms of [999, 3_600_001, 1500.5, '5000']) {
        assert.equal((await post('/api/touch-strip-repaint', { ms })).status, 400, String(ms));
      }
      assert.equal((await post('/api/touch-strip-repaint', { ms: 5000 })).status, 409);
    },
  );

  await runWebTest('POST /api/encoders: bad shape → 400, valid body on MK.2 → 409', async () => {
    assert.equal((await post('/api/encoders', { connectToApp: 'no' })).status, 400);
    assert.equal((await post('/api/encoders', { commands: { '9': {} } })).status, 400);
    assert.equal((await post('/api/encoders', { commands: { '0': { press: 1 } } })).status, 400);
    assert.equal((await post('/api/encoders', { connectToApp: false })).status, 409);
  });

  await runWebTest(
    'POST /api/extra-key/press: bad body → 400, MK.2 has no extra key → 400',
    async () => {
      assert.equal((await post('/api/extra-key/press', { wireId: -1, command: 'x' })).status, 400);
      assert.equal((await post('/api/extra-key/press', { wireId: 15, command: 1 })).status, 400);
      const long = 'x'.repeat(513);
      assert.equal((await post('/api/extra-key/press', { wireId: 15, command: long })).status, 400);
      assert.equal((await post('/api/extra-key/press', { wireId: 15, command: 'x' })).status, 400);
      const error = async (body: unknown): Promise<string> =>
        ((await (await post('/api/extra-key/press', body)).json()) as { error: string }).error;
      assert.ok((await error({ wireId: 15 })).includes('command or action'));
      assert.ok((await error({ wireId: 15, action: 'run' })).includes('refresh, command, both'));
      assert.ok((await error({ wireId: 15, action: 'both' })).includes('no extra key'), 'valid');
    },
  );

  await runWebTest('POST /api/extra-key: bad style.* → 400 naming the field', async () => {
    const cases: Array<[unknown, string]> = [
      [{ textSize: 3 }, 'style.textSize must be one of: fit, -2, -1, 0, 1, 2'],
      [{ wrap: 'lines' }, 'style.wrap must be one of: words, chars'],
      [{ padding: 17 }, 'style.padding must be an integer 0..16'],
      [{ color: 'red' }, 'style.color must be a #rrggbb colour'],
      ['big', 'style must be an object'],
    ];
    for (const [style, message] of cases) {
      const res = await post('/api/extra-key', { wireId: 15, widget: 'text', style });
      assert.equal(res.status, 400, message);
      assert.equal(((await res.json()) as { error: string }).error, message);
    }
  });

  await runWebTest(
    'GET/POST /api/standby: defaults, validated write, 400 on bad bodies',
    async () => {
      const got = (await (await fetch(`${base}/api/standby`)).json()) as StandbyView;
      assert.equal(got.settings.idleDim, false);
      assert.ok(/^\d\d:\d\d$/.test(got.serverTime));
      assert.equal(got.hasCommands, false);
      const ok = await post('/api/standby', { settings: { idleDim: true, idleMinutes: 3 } });
      assert.equal(ok.status, 200);
      const view = (await ok.json()) as StandbyView;
      assert.equal(view.settings.idleDim, true);
      assert.equal(view.settings.idleMinutes, 3);
      assert.equal((await post('/api/standby', { settings: { idleLevel: 150 } })).status, 400);
      assert.equal((await post('/api/standby', { settings: 'x' })).status, 400);
      assert.equal((await post('/api/standby', {})).status, 400);
      const after = (await (await fetch(`${base}/api/standby`)).json()) as StandbyView;
      assert.equal(after.settings.idleMinutes, 3, 'a rejected write changes nothing');
    },
  );

  await runWebTest(
    'POST /api/extra-key/preview: bad wireId → 400, MK.2 has no extra key → 400',
    async () => {
      assert.equal((await post('/api/extra-key/preview', { wireId: -1 })).status, 400);
      assert.equal((await post('/api/extra-key/preview', { wireId: 15 })).status, 400);
    },
  );

  await runWebTest('POST /api/mock/* → 404 with a real driver', async () => {
    assert.equal((await post('/api/mock/extra-key/15', {})).status, 404);
    assert.equal(
      (await post('/api/mock/dial', { index: 0, kind: 'rotate', delta: 1 })).status,
      404,
    );
    assert.equal((await post('/api/mock/touch', { type: 'tap', x: 0, y: 0 })).status, 404);
  });

  await runWebTest('POST /api/touch-strip (removed) → 404', async () => {
    assert.equal((await post('/api/touch-strip', { disabled: true })).status, 404);
  });

  const goDocs = (topic: string, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${base}/go/docs/${topic}`, { redirect: 'manual', headers });
  const ownNav = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Dest': 'document' };

  await runWebTest('GET /go/docs/:topic: unknown topic → 404, nothing recorded', async () => {
    assert.equal((await goDocs('nope', ownNav)).status, 404);
    assert.equal((await goDocs('__proto__', ownNav)).status, 404);
    assert.deepEqual(routesUi.settings.docsSeen, []);
  });

  await runWebTest(
    'GET /go/docs/:topic: own navigation → 302 to docsUrl, topic recorded',
    async () => {
      const r = await goDocs('image-fit', ownNav);
      assert.equal(r.status, 302);
      assert.equal(r.headers.get('location'), docsUrl('image-fit'));
      assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
      // A CI/kill-switch environment legitimately suppresses recording.
      if (docsTrackingAllowed(routesUi.settings.a7s, tjs.env)) {
        assert.deepEqual(routesUi.settings.docsSeen, ['image-fit']);
      }
      routesUi.settings.docsSeen = [];
    },
  );

  await runWebTest('GET /go/docs/:topic: cross-site or opted-out → 302, not recorded', async () => {
    const r = await goDocs('push-api', { 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), docsUrl('push-api'));
    routesUi.settings.a7s = false;
    assert.equal((await goDocs('push-api', ownNav)).status, 302);
    routesUi.settings.a7s = undefined;
    assert.deepEqual(routesUi.settings.docsSeen, []);
  });
} finally {
  await routesUi.stop().catch(() => undefined);
}

// WebUIServer: mock input simulation (POST /api/mock/*)

console.log('\nwebui: mock input simulation');

const MOCK_INPUT_TEST_PORT = 13005;
const mockUi = new WebUIServer(
  MOCK_INPUT_TEST_PORT,
  [],
  'mock',
  new PersistedSettings(TEST_SETTINGS_ROOT),
);
await mockUi.start();

try {
  const base = `http://127.0.0.1:${mockUi.port}`;
  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const emitted: unknown[] = [];
  mockUi.on('mockInput', (input: unknown) => emitted.push(input));

  await runWebTest('plain MK.2: no pressable extra key, knobs or strip → 400', async () => {
    mockUi.notifyDocks([fakeDockStatus(0)]);
    assert.equal((await post('/api/mock/extra-key/15', {})).status, 400);
    assert.equal(
      (await post('/api/mock/dial', { index: 0, kind: 'rotate', delta: 1 })).status,
      400,
    );
    assert.equal((await post('/api/mock/touch', { type: 'tap', x: 0, y: 0 })).status, 400);
    assert.equal(emitted.length, 0);
  });

  await runWebTest('AKP05E-like dock: valid input → 204 + mockInput emitted', async () => {
    mockUi.notifyDocks([
      { ...fakeDockStatus(0), extraKeys: [15, 10], pressableExtraKeys: [15, 10], encoderCount: 4 },
    ]);
    assert.equal((await post('/api/mock/extra-key/10', {})).status, 204);
    assert.equal(
      (await post('/api/mock/dial', { index: 3, kind: 'press', state: 'down' })).status,
      204,
    );
    const swipe = { type: 'swipe', x: 0, y: 50, endX: 799, endY: 50 };
    assert.equal((await post('/api/mock/touch', swipe)).status, 204);
    assert.deepEqual(emitted, [
      { kind: 'extraKey', wireId: 10 },
      { kind: 'dial', event: { index: 3, kind: 'press', state: 'down' } },
      { kind: 'touch', event: swipe },
    ]);
  });

  await runWebTest('AKP05E-like dock: out-of-range or malformed input → 400', async () => {
    emitted.length = 0;
    const cases: Array<[string, unknown]> = [
      ['/api/mock/extra-key/16', {}],
      ['/api/mock/extra-key/-1', {}],
      ['/api/mock/dial', { index: 4, kind: 'rotate', delta: 1 }],
      ['/api/mock/dial', { index: 0, kind: 'rotate', delta: 0 }],
      ['/api/mock/dial', { index: 0, kind: 'press', state: 'held' }],
      ['/api/mock/dial', 'not json'],
      ['/api/mock/touch', { type: 'tap', x: 800, y: 0 }],
      ['/api/mock/touch', { type: 'poke', x: 0, y: 0 }],
      ['/api/mock/touch', { type: 'swipe', x: 0, y: 0 }],
    ];
    for (const [path, body] of cases) {
      assert.equal((await post(path, body)).status, 400, `${path} ${JSON.stringify(body)}`);
    }
    assert.equal(emitted.length, 0, 'nothing reaches the driver');
  });
} finally {
  await mockUi.stop().catch(() => undefined);
}

// WebUIServer settings persistence

console.log('\nWebUIServer.getSettingsJson / applySettingsJson');

/** A well-formed devices[] entry for `deviceKey` with optional per-device
 *  settings merged in (identity fields match fakeDockStatus's deviceKey). */
function deviceEntry(
  deviceKey: string,
  settings: Partial<{
    brightness: number;
    brightnessOverride: boolean;
    touchStripMode: unknown;
    touchStripRepaintMs: unknown;
    touchStripZoneFit: unknown;
    touchStripUpload: unknown;
    encoders: unknown;
    tapFeedback: unknown;
  }> = {},
): Record<string, unknown> {
  return {
    deviceKey,
    mdnsServiceName: 'Dock',
    macAddress: '02:00:00:00:00:01',
    dockSerial: 'A7FZA5190ILSAA',
    childSerial: 'A7FZA5191ILSNQ',
    ...settings,
  };
}

test('getSettingsJson: notifyDocks syncs each dock brightness into its device entry', () => {
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
  ui.settings.getOrCreateIdentity('fake-device-0', 'Dock');
  ui.notifyDocks([{ ...fakeDockStatus(0), brightness: 33 }]);
  const parsed = JSON.parse(ui.settings.json()) as { devices?: { brightness?: number }[] };
  assert.equal(
    parsed.devices?.[0]?.brightness,
    33,
    "entry brightness follows the dock's live value",
  );
});

test('applySettingsJson: devices[] import applies per-device override to selected dock', () => {
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
  ui.notifyDocks([{ ...fakeDockStatus(0), brightness: 10 }]);
  ui.settingsFile.applyJson(
    JSON.stringify({
      devices: [deviceEntry('fake-device-0', { brightnessOverride: true })],
    }),
  );
  assert.equal(ui.fullState().brightnessOverride, true, "selected dock's override resolved");
});

test('applySettingsJson: an invalid touchStripMode is stripped without dropping the device', () => {
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
  ui.notifyDocks([fakeDockStatus(0)]);
  ui.settingsFile.applyJson(
    JSON.stringify({
      devices: [deviceEntry('fake-device-0', { touchStripMode: 'not-a-mode' })],
    }),
  );
  const parsed = JSON.parse(ui.settings.json()) as { devices?: unknown[] };
  assert.deepEqual(
    parsed.devices,
    [deviceEntry('fake-device-0', {})],
    'identity stored without invalid mode',
  );
});

test('applySettingsJson throws on malformed JSON, state unchanged', () => {
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
  ui.notifyDocks([{ ...fakeDockStatus(0), brightness: 20 }]);
  assert.throws(() => ui.settingsFile.applyJson('not-json{{'));
  assert.equal(ui.snapshot().brightness, 20, 'brightness unchanged after rejected input');
});

test('applySettingsJson throws on a JSON array (not an object)', () => {
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
  assert.throws(() => ui.settingsFile.applyJson('[1,2,3]'));
});

test('applySettingsJson: an unknown selectedDock is ignored, not fatal', () => {
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
  ui.notifyDocks([fakeDockStatus(0)]);
  ui.settingsFile.applyJson(JSON.stringify({ selectedDock: 99 }));
  assert.equal(ui.fullState().selectedDock, 0, 'selection stays on the primary');
});

// WebUIServer device identity (getOrCreateDeviceIdentity / updateDeviceMdnsName)

console.log('\nWebUIServer device identity');

const DEVICE_IDENTITY_TEST_ROOT = `${tjs.tmpDir}/webui-device-identity-test-${tjs.pid}`;

test('getOrCreateDeviceIdentity: absent key generates + appears in getSettingsJson', () => {
  // Disk persistence itself (saveSettings/loadSettings round-trip, including
  // devices[]) is covered by settings-store.test.ts — this only verifies the
  // WebUIServer wiring: a newly-generated identity is reflected in-memory via
  // currentSettings() immediately, without depending on async disk I/O timing.
  const dir = `${DEVICE_IDENTITY_TEST_ROOT}/generate`;
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(dir));
  const identity = ui.settings.getOrCreateIdentity('/dev/hidraw3', 'My Dock');
  assert.equal(identity.deviceKey, '/dev/hidraw3');
  assert.equal(identity.mdnsServiceName, 'My Dock');

  const body = JSON.parse(ui.settings.json()) as { devices?: { deviceKey: string }[] };
  assert.ok(Array.isArray(body.devices), 'devices[] present in the settings snapshot');
  assert.equal(body.devices?.length, 1, 'exactly one entry');
  assert.equal(
    body.devices?.[0]?.deviceKey,
    '/dev/hidraw3',
    'entry matches the generated identity',
  );
});

test('getOrCreateDeviceIdentity: present key reuses the stored entry, does not re-persist', () => {
  const dir = `${DEVICE_IDENTITY_TEST_ROOT}/reuse`;
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(dir));
  const first = ui.settings.getOrCreateIdentity('/dev/hidraw3', 'My Dock');
  const second = ui.settings.getOrCreateIdentity('/dev/hidraw3', 'A Different Default');
  assert.equal(second, first, 'same object reference — not regenerated');
  assert.equal(second.mdnsServiceName, 'My Dock', 'original name kept, default ignored on reuse');
});

test('updateDeviceMdnsName: renames an existing entry, returns true', () => {
  const dir = `${DEVICE_IDENTITY_TEST_ROOT}/rename`;
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(dir));
  ui.settings.getOrCreateIdentity('/dev/hidraw3', 'My Dock');
  const ok = ui.settings.updateMdnsName('/dev/hidraw3', 'Renamed Dock');
  assert.equal(ok, true);
  assert.equal(
    ui.settings.getOrCreateIdentity('/dev/hidraw3', 'ignored').mdnsServiceName,
    'Renamed Dock',
  );
});

test('updateDeviceMdnsName: unknown deviceKey returns false, no-op', () => {
  const dir = `${DEVICE_IDENTITY_TEST_ROOT}/unknown`;
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(dir));
  const ok = ui.settings.updateMdnsName('/dev/nonexistent', 'Whatever');
  assert.equal(ok, false);
});

// WebUIServer: POST /api/device-identity/mdns-name

console.log('\nwebui: POST /api/device-identity/mdns-name');

const MDNS_ROUTE_TEST_PORT = 13004;
const mdnsRouteUi = await webUIAt(`${DEVICE_IDENTITY_TEST_ROOT}/route`, MDNS_ROUTE_TEST_PORT);
await mdnsRouteUi.start();

try {
  const base = `http://127.0.0.1:${mdnsRouteUi.port}`;

  await runWebTest('valid body → 200, persists and emits mdnsNameChanged', async () => {
    mdnsRouteUi.settings.getOrCreateIdentity('/dev/hidraw3', 'Dock');
    let emitted: unknown[] | null = null;
    mdnsRouteUi.on('mdnsNameChanged', (...args: unknown[]) => {
      emitted = args;
    });
    const r = await fetch(`${base}/api/device-identity/mdns-name`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceKey: '/dev/hidraw3', name: '  My Dock  ' }),
    });
    assert.equal(r.status, 200);
    const body = (await r.json()) as { ok: boolean; name: string };
    assert.equal(body.ok, true);
    assert.equal(body.name, 'My Dock', 'name is trimmed');
    assert.deepEqual(
      emitted,
      ['/dev/hidraw3', 'My Dock'],
      'event carries deviceKey + trimmed name',
    );
    assert.equal(mdnsRouteUi.settings.entryFor('/dev/hidraw3')?.mdnsServiceName, 'My Dock');
  });

  await runWebTest('unknown deviceKey → 404, nothing emitted', async () => {
    let emitted = false;
    mdnsRouteUi.on('mdnsNameChanged', () => {
      emitted = true;
    });
    const r = await fetch(`${base}/api/device-identity/mdns-name`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceKey: '/dev/none', name: 'My Dock' }),
    });
    assert.equal(r.status, 404);
    assert.equal(emitted, false);
  });

  await runWebTest('missing deviceKey → 400', async () => {
    const r = await fetch(`${base}/api/device-identity/mdns-name`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'My Dock' }),
    });
    assert.equal(r.status, 400);
  });

  await runWebTest('blank name → 400', async () => {
    const r = await fetch(`${base}/api/device-identity/mdns-name`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceKey: '/dev/hidraw3', name: '   ' }),
    });
    assert.equal(r.status, 400);
  });

  await runWebTest('malformed JSON → 400', async () => {
    const r = await fetch(`${base}/api/device-identity/mdns-name`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    assert.equal(r.status, 400);
  });
} finally {
  await mdnsRouteUi.stop().catch(() => undefined);
}

// WebUIServer: beginShutdown refuses mutations

console.log('\nwebui: beginShutdown');

const SHUTDOWN_TEST_PORT = 13005;
const shutdownUi = await webUIAt(`${DEVICE_IDENTITY_TEST_ROOT}/shutdown`, SHUTDOWN_TEST_PORT);
await shutdownUi.start();

try {
  const base = `http://127.0.0.1:${shutdownUi.port}`;
  const mdnsPost = (): Promise<Response> =>
    fetch(`${base}/api/device-identity/mdns-name`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceKey: '/dev/hidraw9', name: 'X' }),
    });

  await runWebTest('after beginShutdown: POST → 503 without mutating, GET still 200', async () => {
    shutdownUi.settings.getOrCreateIdentity('/dev/hidraw9', 'Dock');
    let emitted = false;
    shutdownUi.on('mdnsNameChanged', () => {
      emitted = true;
    });
    assert.equal((await mdnsPost()).status, 200, 'works before shutdown');
    emitted = false;
    shutdownUi.beginShutdown();
    const r = await mdnsPost();
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { error: 'shutting down' });
    assert.equal(emitted, false, 'handler never ran');
    assert.equal((await fetch(`${base}/api/state`)).status, 200);
  });
} finally {
  await shutdownUi.stop().catch(() => undefined);
}

// WebUIServer: GET/POST /api/settings

console.log('\nwebui: GET/POST /api/settings');

const SETTINGS_TEST_PORT = 13003;
const settingsUi = await webUIAt(TEST_SETTINGS_ROOT, SETTINGS_TEST_PORT);
await settingsUi.start();

try {
  const base = `http://127.0.0.1:${settingsUi.port}`;

  await runWebTest('GET /api/settings returns current settings', async () => {
    const r = await fetch(`${base}/api/settings`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as Record<string, unknown>;
    assert.ok('selectedDock' in body);
  });

  await runWebTest('POST /api/settings with valid JSON → 200, applies + persists', async () => {
    const device = {
      deviceKey: '/dev/hidraw9',
      mdnsServiceName: 'Imported Dock',
      macAddress: '02:00:00:00:00:09',
      dockSerial: 'A7FZA5190ILSAA',
      childSerial: 'A7FZA5191ILSNQ',
      brightness: 77,
    };
    const r = await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectedDock: 0, devices: [device] }),
    });
    assert.equal(r.status, 200);
    const back = JSON.parse(settingsUi.settings.json()) as {
      devices?: { brightness?: number }[];
    };
    assert.equal(back.devices?.[0]?.brightness, 77, 'imported device entry applied + retained');
  });

  await runWebTest('POST /api/settings with malformed JSON → 400', async () => {
    const r = await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    assert.equal(r.status, 400);
  });

  const post = (body: Record<string, unknown>): Promise<Response> =>
    fetch(`${base}/api/browser-locale`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  await runWebTest('browser locale route keeps timezone in memory only', async () => {
    assert.equal((await post({ locale: 'sk-SK', timeZone: 'Europe/Bratislava' })).status, 200);
    assert.equal(settingsUi.settings.browserLocale, 'sk-SK');
    assert.equal(settingsUi.settings.browserTimeZone, 'Europe/Bratislava');
    assert.ok(!('browserTimeZone' in JSON.parse(settingsUi.settings.json())));
    assert.equal((await post({ locale: 'en-GB' })).status, 200);
    assert.equal(settingsUi.settings.browserTimeZone, undefined);
    assert.equal((await post({ locale: 'en-GB', timeZone: 123 })).status, 400);
    assert.equal((await post({ locale: 'en-GB', timeZone: 'x'.repeat(65) })).status, 400);
  });
} finally {
  await settingsUi.stop().catch(() => undefined);
}

// WebUIServer: load-time prune of legacy path-keyed entries

console.log('\nwebui: load prunes non-serial deviceKeys');

const PRUNE_TEST_PORT = 13004;
const PRUNE_ROOT = `${tjs.tmpDir}/webui-prune-test-${tjs.pid}`;

const mkPruneEntry = (deviceKey: string, brightness: number) => ({
  deviceKey,
  mdnsServiceName: `Dock ${deviceKey}`,
  macAddress: '02:00:00:00:00:01',
  dockSerial: 'A7FZA5190ILSAA',
  childSerial: 'A7FZA5191ILSNQ',
  brightness,
});

await runWebTest('start() drops path-keyed entries, keeps usb:<serial> keys', async () => {
  // Seed disk with the exact failure shape: same physical unit under two
  // volatile IOKit paths + one stable serial key.
  await saveSettings(
    {
      selectedDock: 0,
      devices: [
        mkPruneEntry('DevSrvsID:4295289289', 27),
        mkPruneEntry('DevSrvsID:4295295811', 100),
        mkPruneEntry('usb:0300D0782F51', 42),
      ],
    },
    PRUNE_ROOT,
  );
  const ui = await webUIAt(PRUNE_ROOT, PRUNE_TEST_PORT);
  await ui.start();
  try {
    const body = JSON.parse(ui.settings.json()) as { devices?: { deviceKey: string }[] };
    assert.equal(body.devices?.length, 1, 'only the serial-keyed entry survives');
    assert.equal(body.devices?.[0]?.deviceKey, 'usb:0300D0782F51');
  } finally {
    await ui.stop().catch(() => undefined);
  }
});

await runWebTest(
  'load() strips bad strip/encoder fields + legacy touchStripDisabled, keeps the entry',
  async () => {
    await saveSettings(
      {
        devices: [
          {
            ...mkPruneEntry('usb:0300D0782F51', 42),
            touchStripMode: 'sometimes',
            encoders: { connectToApp: 'no' },
            touchStripDisabled: true,
          } as unknown as NonNullable<Settings['devices']>[number],
        ],
      },
      PRUNE_ROOT,
    );
    const ui = await webUIAt(PRUNE_ROOT);
    const body = JSON.parse(ui.settings.json()) as { devices?: Record<string, unknown>[] };
    assert.equal(body.devices?.length, 1, 'identity entry survives (no Elgato re-pair)');
    const entry = body.devices![0]!;
    assert.equal(entry.brightness, 42);
    for (const k of ['touchStripMode', 'encoders', 'touchStripDisabled']) {
      assert.ok(!(k in entry), `${k} stripped`);
    }
    assert.equal(ui.settings.for('usb:0300D0782F51').stripMode(), 'elgato');
  },
);

// Device tuning (modelOverrides) + log level — see devices/model-overrides.ts

console.log('\nWebUIServer device tuning + log level');

/** A registry model id every build has, so these tests don't depend on the
 *  probe order or on hardware. */
const TUNED_MODEL = 'mirabox-293';

await runWebTest(
  'batch transfer tuning persists, resets, and rejects unsupported devices',
  async () => {
    const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
    for (const [modelId, defaultEnabled] of [
      ['mirabox-293s', true],
      ['ajazz-akp153', false],
    ] as const) {
      ui.modelOverrides.tryReset(modelId);
      const initial = ui.modelOverrides.view(modelId);
      assert.ok(!('error' in initial));
      if ('error' in initial) continue;
      assert.equal(initial.tunable.wire!.batchImageTransfers, defaultEnabled);
      assert.ok(
        !(
          'error' in
          ui.modelOverrides.trySet(modelId, { wire: { batchImageTransfers: !defaultEnabled } })
        ),
        'batching toggles on a supported board',
      );
      const saved = ui.modelOverrides.view(modelId);
      assert.ok(!('error' in saved));
      if (!('error' in saved))
        assert.equal(saved.effective.wire?.batchImageTransfers, !defaultEnabled);
      const importRoot = `${TEST_SETTINGS_ROOT}-batch-import`;
      await saveSettings(JSON.parse(ui.settings.json()) as Settings, importRoot);
      const restoredUi = await webUIAt(importRoot);
      const persisted = restoredUi.modelOverrides.view(modelId);
      assert.ok(!('error' in persisted));
      if (!('error' in persisted))
        assert.equal(persisted.tunable.wire?.batchImageTransfers, !defaultEnabled);
      await restoredUi.stop();
      ui.modelOverrides.tryReset(modelId);
      const reset = ui.modelOverrides.view(modelId);
      if (!('error' in reset))
        assert.equal(reset.tunable.wire?.batchImageTransfers, defaultEnabled);
    }
    assert.ok(
      'error' in ui.modelOverrides.trySet('fifine-d6', { wire: { batchImageTransfers: true } }),
      'batching is rejected on a model without the 293S board',
    );
  },
);

test('device-overrides view seeds from the registry when nothing is persisted', () => {
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
  const view = ui.modelOverrides.view(TUNED_MODEL);
  assert.ok(!('error' in view), 'known model resolves');
  if (!('error' in view)) {
    assert.equal(view.modelId, TUNED_MODEL);
    assert.deepEqual(view.overrides, {}, 'nothing tuned yet');
    assert.equal(view.effective.image.rotate, view.defaults.image?.rotate, 'effective = default');
  }
});

test('device-overrides default view follows the selected dock', () => {
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
  ui.notifyDocks([
    { ...fakeDockStatus(0), modelId: TUNED_MODEL },
    { ...fakeDockStatus(1), modelId: 'mirabox-293s', modelName: 'Mirabox 293S' },
  ]);
  ui.selectDock(1);
  const view = ui.modelOverrides.view();
  assert.ok(!('error' in view));
  if (!('error' in view)) assert.equal(view.modelId, 'mirabox-293s');
});

test('the form seed round-trips: POSTing `tunable` unchanged is accepted', () => {
  // Regression: the panel used to seed from `effective`, which carries the
  // non-tunable protocol facts (format/colorMode/bmpPpm) as well — so pressing
  // Apply without touching anything failed with "image.format: unknown field".
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
  for (const modelId of [
    'mk2',
    'mini',
    TUNED_MODEL,
    'mirabox-k1pro',
    'fifine-d6',
    'ajazz-akp153',
  ]) {
    const view = ui.modelOverrides.view(modelId);
    assert.ok(!('error' in view), `${modelId} resolves`);
    if ('error' in view) continue;
    assert.ok(
      !('error' in ui.modelOverrides.trySet(modelId, view.tunable)),
      `${modelId}: the seed the UI renders must be a valid override`,
    );
    ui.modelOverrides.tryReset(modelId);
  }
});

test('`tunable` excludes the protocol facts `effective` exposes', () => {
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
  const view = ui.modelOverrides.view('mk2');
  assert.ok(!('error' in view));
  if ('error' in view) return;
  assert.equal(view.effective.image.format, 'jpeg', 'effective keeps format for display');
  const seedKeys = Object.keys(view.tunable.image ?? {});
  for (const excluded of ['format', 'colorMode', 'bmpPpm']) {
    assert.ok(!seedKeys.includes(excluded), `${excluded} must not reach the form`);
  }
});

test('a seeded-then-edited override is still accepted', () => {
  // The actual user flow: open the panel, change rotation, press Apply.
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
  const view = ui.modelOverrides.view(TUNED_MODEL);
  assert.ok(!('error' in view));
  if ('error' in view) return;
  const edited = { ...view.overrides, image: { ...view.tunable.image, rotate: 90 as const } };
  assert.ok(!('error' in ui.modelOverrides.trySet(TUNED_MODEL, edited)), 'the edited seed applies');
  const after = ui.modelOverrides.view(TUNED_MODEL);
  assert.ok(!('error' in after) && after.effective.image.rotate === 90);
  ui.modelOverrides.tryReset(TUNED_MODEL);
});

test('device-overrides view 404s on an unknown model id', () => {
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
  const view = ui.modelOverrides.view('not-a-model');
  assert.ok('error' in view && view.status === 404, 'unknown id is a 404, not a crash');
});

test('a valid override persists and shows up in the effective spec', () => {
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
  assert.deepEqual(ui.modelOverrides.trySet(TUNED_MODEL, { image: { rotate: 180 } }), {
    kind: 'live',
  });
  const view = ui.modelOverrides.view(TUNED_MODEL);
  assert.ok(!('error' in view));
  if (!('error' in view)) assert.equal(view.effective.image.rotate, 180);
  const parsed = JSON.parse(ui.settings.json()) as {
    modelOverrides?: Record<string, { image?: { rotate?: number } }>;
  };
  assert.equal(parsed.modelOverrides?.[TUNED_MODEL]?.image?.rotate, 180, 'written to settings');
});

test('an invalid override is rejected with the full error list, nothing persisted', () => {
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
  const r = ui.modelOverrides.trySet(TUNED_MODEL, { image: { rotate: 45, quality: 9 } });
  const err = 'error' in r ? r : null;
  assert.ok(err !== null, 'rejected');
  assert.equal(err?.status, 400);
  assert.ok(err?.error.includes('image.rotate'), err?.error);
  assert.ok(err?.error.includes('image.quality'), 'every bad field is reported at once');
  assert.equal(ui.settings.overrideFor(TUNED_MODEL), undefined, 'nothing stored');
});

test('reset clears the override', () => {
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
  ui.modelOverrides.trySet(TUNED_MODEL, { image: { rotate: 90 } });
  assert.ok(ui.settings.overrideFor(TUNED_MODEL) !== undefined, 'precondition: tuned');
  assert.deepEqual(ui.modelOverrides.tryReset(TUNED_MODEL), { kind: 'live' });
  assert.equal(ui.settings.overrideFor(TUNED_MODEL), undefined);
});

test('applySettingsJson imports modelOverrides and drops invalid entries', () => {
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
  ui.settingsFile.applyJson(
    JSON.stringify({
      modelOverrides: {
        [TUNED_MODEL]: { image: { rotate: 270 } },
        'not-a-model': { image: { rotate: 90 } },
        'mirabox-293s': { image: { rotate: 45 } },
      },
    }),
  );
  assert.equal(ui.settings.overrideFor(TUNED_MODEL)?.image?.rotate, 270, 'valid entry kept');
  assert.equal(ui.settings.overrideFor('not-a-model'), undefined, 'unknown model dropped');
  assert.equal(ui.settings.overrideFor('mirabox-293s'), undefined, 'invalid override dropped');
});

test('safe mode reports the registry defaults as effective, but keeps the override', () => {
  // The one time a user opens this panel is when a bad override made the device
  // look dead — a view that disagreed with the hardware would mislead them. The
  // stored value stays so Reset still works.
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
  ui.modelOverrides.trySet(TUNED_MODEL, { image: { rotate: 180 } });
  const before = ui.modelOverrides.view(TUNED_MODEL);
  assert.ok(!('error' in before) && before.effective.image.rotate === 180, 'precondition');

  tjs.env.DECKBRIDGE_NO_OVERRIDES = '1';
  try {
    const view = ui.modelOverrides.view(TUNED_MODEL);
    assert.ok(!('error' in view));
    if (!('error' in view)) {
      assert.equal(view.safeMode, true, 'the UI can say so');
      assert.equal(view.effective.image.rotate, 0, 'effective = what the device runs');
      assert.equal(view.overrides.image?.rotate, 180, 'the override is still stored');
    }
  } finally {
    delete tjs.env.DECKBRIDGE_NO_OVERRIDES;
  }
  ui.modelOverrides.tryReset(TUNED_MODEL);
});

test('trySetLogLevel validates and persists', () => {
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
  assert.equal(ui.logging.trySetLevel('debug'), null);
  assert.equal(ui.logging.level(), 'debug', 'applied to the main thread');
  const parsed = JSON.parse(ui.settings.json()) as { logLevel?: string };
  assert.equal(parsed.logLevel, 'debug', 'written to settings');
  const err = ui.logging.trySetLevel('loud');
  assert.equal(err?.status, 400);
  assert.equal(ui.logging.level(), 'debug', 'a rejected level does not change anything');
  ui.logging.trySetLevel('warn'); // restore: setLogLevel is process-wide
});

test('fullState exposes the log level and log path for the Settings page', () => {
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
  const state = ui.fullState();
  assert.equal(typeof state.logLevel, 'string');
  assert.ok(state.logFilePath.endsWith('deckbridge.log'), state.logFilePath);
});

test('fullState omits logs/commLogs in simple-only builds (the test build default)', () => {
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
  const state = ui.fullState();
  assert.equal(state.logs, undefined, 'no log panel to receive it in a simple-only build');
  assert.equal(state.commLogs, undefined, 'no comm panel to receive it in a simple-only build');
  assert.ok(Array.isArray(state.keyEvents), 'keyEvents is unaffected');
});

await runWebTest(
  'invalid modelOverrides on disk are dropped at load, leaving the rest intact',
  async () => {
    const root = `${tjs.tmpDir}/webui-overrides-load-${tjs.pid}`;
    await saveSettings(
      {
        selectedDock: 0,
        // Written straight to disk (bypassing validation) the way a hand-edited
        // or imported settings.json can be.
        modelOverrides: {
          [TUNED_MODEL]: { image: { rotate: 180 } },
          'mirabox-293s': { image: { rotate: 45 } },
        },
      } as never,
      root,
    );
    const ui = await webUIAt(root);
    assert.equal(ui.settings.overrideFor(TUNED_MODEL)?.image?.rotate, 180, 'valid entry survives');
    assert.equal(ui.settings.overrideFor('mirabox-293s'), undefined, 'invalid entry dropped');
    await tjs.remove(root, { recursive: true }).catch(() => undefined);
  },
);

await runWebTest(
  'tapFeedback: defaults when absent, merged per flag, invalid ignored at load',
  async () => {
    const root = `${tjs.tmpDir}/webui-tap-feedback-${tjs.pid}`;
    await saveSettings(
      {
        selectedDock: 0,
        devices: [
          deviceEntry('usb:A'),
          deviceEntry('usb:B', { tapFeedback: { placeholder: true } }),
          deviceEntry('usb:C', { tapFeedback: { flash: 'yes' } }),
          deviceEntry('usb:D', { tapFeedback: [true] }),
        ],
      } as never,
      root,
    );
    const ui = await webUIAt(root);
    assert.deepEqual(
      ui.settings.for('usb:A').tapFeedback(),
      { flash: true, placeholder: false },
      'absent',
    );
    assert.deepEqual(
      ui.settings.for('usb:B').tapFeedback(),
      { flash: true, placeholder: true },
      'partial',
    );
    assert.deepEqual(
      ui.settings.for('usb:C').tapFeedback(),
      { flash: true, placeholder: false },
      'bad flag',
    );
    assert.deepEqual(
      ui.settings.for('usb:D').tapFeedback(),
      { flash: true, placeholder: false },
      'array',
    );
    const devices = (JSON.parse(ui.settings.json()) as { devices: Record<string, unknown>[] })
      .devices;
    assert.equal(devices.length, 4, 'a bad tapFeedback never drops the identity entry');
    assert.equal(devices[2]!.tapFeedback, undefined, 'invalid field stripped');
    await tjs.remove(root, { recursive: true }).catch(() => undefined);
  },
);

// StandbyController (selected dock's standby settings)

console.log('\nstandby controller');

function standbyUi() {
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(TEST_SETTINGS_ROOT));
  ui.settings.getOrCreateIdentity('fake-device-0', 'Dock');
  ui.notifyDocks([{ ...fakeDockStatus(0), standbyCaps: { sleep: true, clock: false } }]);
  const changed: unknown[][] = [];
  ui.on('standbyChanged', (...args: unknown[]) => changed.push(args));
  const stored = () => ui.settings.entryFor('fake-device-0')?.standby;
  return { ui, changed, stored };
}

test('standby view: defaults, host time, capabilities from the dock status', () => {
  const { ui } = standbyUi();
  const view = ui.standby.view();
  assert.deepEqual(view.settings, publicStandby(DEFAULT_STANDBY));
  assert.ok(/^\d\d:\d\d$/.test(view.serverTime));
  assert.equal(view.dock, 0);
  assert.equal(view.canSleep, true);
  assert.equal(view.canShowClock, false);
  assert.equal(view.hasCommands, false);
});

test('standby set: persists the merge, emits standbyChanged for the selected dock', () => {
  const { ui, changed, stored } = standbyUi();
  const r = ui.standby.trySet({ settings: { idleDim: true, idleMinutes: 3 } });
  assert.ok('view' in r && r.view.settings.idleMinutes === 3);
  assert.deepEqual(stored(), { idleDim: true, idleMinutes: 3 });
  assert.deepEqual(changed, [[0]]);
  ui.standby.trySet({ settings: { idleLevel: 20 } });
  assert.deepEqual(stored(), { idleDim: true, idleMinutes: 3, idleLevel: 20 }, 'merged');
});

test('standby set: invalid values and start == end are 400 and persist nothing', () => {
  const { ui, changed, stored } = standbyUi();
  for (const settings of [{ idleLevel: 150 }, { nightStart: '08:00', nightEnd: '08:00' }]) {
    const r = ui.standby.trySet({ settings });
    assert.ok('error' in r && r.status === 400, JSON.stringify(settings));
  }
  const notObject = ui.standby.trySet({ settings: [] });
  assert.ok('error' in notObject && notObject.status === 400);
  assert.equal(stored(), undefined);
  assert.equal(changed.length, 0);
});

test('standby set: unknown keys are dropped, command keys are never written by the WebUI', () => {
  const { ui, stored } = standbyUi();
  ui.standby.trySet({ settings: { pixelShift: true, bogus: 1, wakeCommand: 'touch /tmp/x' } });
  assert.deepEqual(stored(), { pixelShift: true });
});

test('standby: stored sleep/wake commands survive a POST and never reach the browser', () => {
  const { ui, stored } = standbyUi();
  ui.settingsFile.applyJson(
    JSON.stringify({
      devices: [
        {
          ...deviceEntry('fake-device-0', {}),
          standby: { wakeCommand: 'touch /tmp/woke', bogus: true },
        },
      ],
    }),
  );
  assert.equal(stored()?.wakeCommand, 'touch /tmp/woke');
  ui.standby.trySet({ settings: { idleDim: true } });
  assert.deepEqual(
    stored(),
    { wakeCommand: 'touch /tmp/woke', idleDim: true },
    'kept, unknown gone',
  );
  const view = ui.standby.view();
  assert.equal(view.hasCommands, true);
  assert.ok(!JSON.stringify(view).includes('woke'), 'the command text is not sent');
});

test('a settings import with devices[].standby emits standbyChanged', () => {
  const { ui, changed, stored } = standbyUi();
  ui.settingsFile.applyJson(
    JSON.stringify({
      devices: [{ ...deviceEntry('fake-device-0', {}), standby: { night: true, nightLevel: 5 } }],
    }),
  );
  assert.deepEqual(stored(), { night: true, nightLevel: 5 });
  assert.deepEqual(changed, [[]], 'no index: every dock reloads, not just the selected one');
});

// Summary

summaryExit();
