import assert from 'tjs:assert';
import {
  isAllowedWebRequest,
  isValidMacAddress,
  pickFallbackPort,
  WebUIServer,
} from '../src/web/server/web-ui-server.js';
import { Broadcaster } from '../src/web/server/broadcaster.js';
import { saveSettings } from '../src/settings-store.js';
import type { Settings } from '../src/settings-store.js';
import type { DockStatus } from '../src/types.js';
import { test, testAsync as runWebTest, summaryExit } from './helpers/harness.js';

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

test('clears imageState/imageVersion and broadcasts repaint', () => {
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
  ui.notifyImageUpdate(0, Buffer.from([1, 2, 3]));
  ui.notifyImageUpdate(1, Buffer.from([4, 5, 6]));
  assert.equal(ui.imageState.size, 2, 'two images set');
  assert.equal(Object.keys(ui.fullState().images).length, 2, 'fullState reports two images');

  let repaintBroadcast = false;
  const origBroadcast = (ui as unknown as { bus: { broadcast: (...a: unknown[]) => void } }).bus
    .broadcast;
  (ui as unknown as { bus: { broadcast: (...a: unknown[]) => void } }).bus.broadcast = (
    ...args: unknown[]
  ) => {
    if (args[0] === 'repaint') repaintBroadcast = true;
    return origBroadcast.apply(
      (ui as unknown as { bus: { broadcast: (...a: unknown[]) => void } }).bus,
      args,
    );
  };

  ui.resetImages();

  assert.equal(ui.imageState.size, 0, 'imageState cleared');
  assert.equal(Object.keys(ui.fullState().images).length, 0, 'fullState images empty');
  assert.ok(repaintBroadcast, 'repaint broadcast sent');
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
    bus.sendTo(sock, 'status', (ui as unknown as { snapshot(): unknown }).snapshot());
  });
  handlers.open(ws);
  return { sent };
}

test('snapshot.docks defaults to empty array', () => {
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
  assert.deepEqual(ui.fullState().docks, []);
});

test('fullState exposes selected dock real device identity', () => {
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
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
  'imageMode',
  'extraKeys',
  'touchStripMode',
  'touchStripRepaint',
  'encoders',
];

test('notifyDocks broadcasts status + selected-device state to a connected WS client', () => {
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
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
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
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

const STRIP = [{ wireId: 1, label: 'Left' }];

test('touch-strip mode: 409 without a strip, else persist + broadcast + touchStripModeChanged', () => {
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
  ui.notifyDocks([fakeDockStatus(0)]);
  assert.equal(ui.trySetTouchStripMode('deckbridge-ignore')?.status, 409, 'MK.2 has no strip');
  assert.equal(ui.touchStripModeFor('fake-device-0'), 'elgato', 'default is Elgato app only');

  ui.getOrCreateDeviceIdentity('fake-device-0', 'Dock');
  ui.notifyDocks([{ ...fakeDockStatus(0), widgetDisplays: STRIP }]);
  const { sent } = connectMockClient(ui);
  sent.length = 0;
  const changed: unknown[][] = [];
  ui.on('touchStripModeChanged', (...args: unknown[]) => changed.push(args));

  assert.equal(ui.trySetTouchStripMode('deckbridge-repaint'), null);
  assert.deepEqual(changed, [[0, 'deckbridge-repaint']]);
  assert.deepEqual(JSON.parse(sent[0]!), {
    event: 'touchStripMode',
    data: { mode: 'deckbridge-repaint' },
  });
  assert.equal(ui.touchStripModeFor('fake-device-0'), 'deckbridge-repaint');
  assert.equal(ui.fullState().touchStripMode, 'deckbridge-repaint');
  const saved = JSON.parse(ui.getSettingsJson()) as { devices: { touchStripMode?: string }[] };
  assert.equal(saved.devices[0]!.touchStripMode, 'deckbridge-repaint', 'persisted per device');
});

test('touch-strip repaint interval: 409 without a strip, default 5 s, else persist + broadcast', () => {
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
  ui.notifyDocks([fakeDockStatus(0)]);
  assert.equal(ui.devicePrefs.trySetTouchStripRepaintMs(2000)?.status, 409, 'MK.2 has no strip');
  assert.equal(ui.devicePrefs.touchStripRepaintMsFor('fake-device-0'), 5000, 'default is 5 s');

  ui.getOrCreateDeviceIdentity('fake-device-0', 'Dock');
  ui.notifyDocks([{ ...fakeDockStatus(0), widgetDisplays: STRIP }]);
  const { sent } = connectMockClient(ui);
  sent.length = 0;

  assert.equal(ui.devicePrefs.trySetTouchStripRepaintMs(2000), null);
  assert.deepEqual(JSON.parse(sent[0]!), { event: 'touchStripRepaint', data: { ms: 2000 } });
  assert.equal(ui.devicePrefs.touchStripRepaintMsFor('fake-device-0'), 2000);
  assert.equal(ui.fullState().touchStripRepaintMs, 2000);
  const saved = JSON.parse(ui.getSettingsJson()) as {
    devices: { touchStripRepaintMs?: number }[];
  };
  assert.equal(saved.devices[0]!.touchStripRepaintMs, 2000, 'persisted per device');
});

test('encoders: 409 without a strip or knobs, 400 past the last knob', () => {
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
  ui.notifyDocks([{ ...fakeDockStatus(0), encoderCount: 4 }]);
  assert.equal(ui.trySetEncoders({ connectToApp: false })?.status, 409, 'no strip');
  ui.notifyDocks([{ ...fakeDockStatus(0), widgetDisplays: STRIP }]);
  assert.equal(ui.trySetEncoders({ connectToApp: false })?.status, 409, 'no knobs');
  ui.notifyDocks([{ ...fakeDockStatus(0), widgetDisplays: STRIP, encoderCount: 2 }]);
  assert.equal(ui.trySetEncoders({ commands: { '2': { press: 'x' } } })?.status, 400);
});

test('encoders: merges per knob, trims blanks, persists and broadcasts', () => {
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
  ui.getOrCreateDeviceIdentity('fake-device-0', 'Dock');
  ui.notifyDocks([{ ...fakeDockStatus(0), widgetDisplays: STRIP, encoderCount: 4 }]);
  const { sent } = connectMockClient(ui);
  sent.length = 0;

  assert.equal(ui.trySetEncoders({ connectToApp: false }), null);
  assert.equal(
    ui.trySetEncoders({
      commands: { '0': { press: ' mute ', rotateCw: 'up' }, '1': { press: 'a' } },
    }),
    null,
  );
  assert.equal(ui.trySetEncoders({ commands: { '1': { press: '' } } }), null, 'emptied knob');

  const expected = { connectToApp: false, commands: { '0': { press: 'mute', rotateCw: 'up' } } };
  assert.deepEqual(ui.encoderSettingsFor('fake-device-0'), expected);
  assert.deepEqual(ui.fullState().encoders, expected);
  assert.deepEqual(JSON.parse(sent.at(-1)!), { event: 'encoders', data: { encoders: expected } });
  const saved = JSON.parse(ui.getSettingsJson()) as { devices: { encoders?: unknown }[] };
  assert.deepEqual(saved.devices[0]!.encoders, expected, 'persisted per device');
});

test('applySettingsJson: bad touchStripMode / encoders fail the device-entry guard', () => {
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
  ui.notifyDocks([fakeDockStatus(0)]);
  const entry = (extra: Parameters<typeof deviceEntry>[1]): string =>
    JSON.stringify({ devices: [deviceEntry('fake-device-0', extra)] });
  const stored = (): unknown[] =>
    (JSON.parse(ui.getSettingsJson()) as { devices?: unknown[] }).devices ?? [];

  ui.applySettingsJson(entry({ touchStripMode: 'sometimes' }));
  assert.equal(stored().length, 0, 'unknown mode rejected');
  ui.applySettingsJson(entry({ touchStripRepaintMs: 10 }));
  assert.equal(stored().length, 0, 'repaint interval below 1 s rejected');
  ui.applySettingsJson(entry({ touchStripZoneFit: 'stretch' }));
  assert.equal(stored().length, 0, 'unknown zone fit rejected');
  ui.applySettingsJson(entry({ touchStripUpload: 'never' }));
  assert.equal(stored().length, 0, 'unknown upload policy rejected');
  ui.applySettingsJson(entry({ encoders: { commands: { '7': { press: 'x' } } } }));
  assert.equal(stored().length, 0, 'knob index out of range rejected');
  ui.applySettingsJson(entry({ encoders: { commands: { '0': { press: 'x'.repeat(513) } } } }));
  assert.equal(stored().length, 0, 'over-long command rejected');

  ui.applySettingsJson(
    entry({ touchStripMode: 'deckbridge-ignore', encoders: { connectToApp: false } }),
  );
  assert.equal(ui.touchStripModeFor('fake-device-0'), 'deckbridge-ignore');
  assert.deepEqual(ui.encoderSettingsFor('fake-device-0'), { connectToApp: false });
  ui.applySettingsJson(entry({ touchStripZoneFit: 'scale', touchStripUpload: 'always' }));
  assert.deepEqual(stored(), [
    deviceEntry('fake-device-0', { touchStripZoneFit: 'scale', touchStripUpload: 'always' }),
  ]);
});

test('extra-key press command: pressable keys only, widget and command replace independently', () => {
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
  ui.getOrCreateDeviceIdentity('fake-device-0', 'Dock');
  ui.notifyDocks([{ ...fakeDockStatus(0), extraKeys: [15, 10], pressableExtraKeys: [15] }]);
  const changed: unknown[][] = [];
  ui.on('extraKeyChanged', (...args: unknown[]) => changed.push(args));
  const cfg = () => ui.extraKeyConfigFor('fake-device-0', 15);

  assert.equal(ui.trySetExtraKey(10, { pressCommand: 'x' })?.status, 400, 'no switch');
  assert.equal(ui.trySetExtraKey(3, { pressCommand: 'x' })?.status, 400, 'no such extra key');
  assert.equal(ui.trySetExtraKey(15, { pressCommand: ' say hi ' }), null);
  assert.deepEqual(cfg(), { widget: 'none', pressCommand: 'say hi' }, 'trimmed, no widget yet');
  assert.equal(changed.length, 0, 'a press command needs no repaint');

  assert.equal(ui.trySetExtraKey(15, { widget: 'clock' }), null);
  assert.deepEqual(cfg(), { widget: 'clock', pressCommand: 'say hi' }, 'widget keeps command');
  assert.deepEqual(changed, [[0]]);
  assert.equal(ui.trySetExtraKey(15, { pressCommand: '' }), null);
  assert.deepEqual(cfg(), { widget: 'clock' }, 'command cleared, widget kept');
  assert.equal(ui.trySetExtraKey(15, { widget: 'none' }), null);
  assert.equal(cfg(), undefined, 'nothing left → entry dropped');

  const entry = (extraKeys: unknown): string =>
    JSON.stringify({ devices: [{ ...deviceEntry('fake-device-0', {}), extraKeys }] });
  ui.applySettingsJson(entry({ '15': { widget: 'none', pressCommand: 'x'.repeat(513) } }));
  assert.equal(cfg(), undefined, 'over-long press command rejected');
  ui.applySettingsJson(entry({ '15': { widget: 'none', pressCommand: 'open -a Music' } }));
  assert.deepEqual(cfg(), { widget: 'none', pressCommand: 'open -a Music' });
});

test("new WS client's initial snapshot carries stored docks", () => {
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
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
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
  const { sent } = connectMockClient(ui);
  sent.length = 0;

  ui.notifyDockImage(0, 3, Buffer.from([1, 2, 3]), 'jpeg');
  assert.equal(sent.length, 1, 'selected dock (0) broadcasts an image');
  assert.equal((JSON.parse(sent[0]!) as { event: string }).event, 'image');
  assert.ok(ui.imageState.has(3), 'selected dock feeds imageState');

  ui.notifyDockImage(1, 5, Buffer.from([9, 9]), 'jpeg');
  assert.equal(sent.length, 1, 'unselected dock does not broadcast');
  assert.ok(!ui.imageState.has(5), 'unselected dock does not touch imageState');
});

test('selectDock swaps the channel and replays the cached frames', () => {
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
  ui.notifyDocks([fakeDockStatus(0), fakeDockStatus(1)]);
  ui.notifyDockImage(0, 0, Buffer.from([1]), 'jpeg');
  ui.notifyDockImage(1, 2, Buffer.from([7, 7]), 'bmp');

  const { sent } = connectMockClient(ui);
  sent.length = 0;

  ui.selectDock(1);

  const events = sent.map((m) => (JSON.parse(m) as { event: string }).event);
  assert.deepEqual(events[0], 'status', 'status broadcast first (selectedDock change)');
  assert.ok(events.includes('image'), "the new dock's cached frames are replayed");
  assert.ok(!ui.imageState.has(0), "old dock's frames dropped from the channel");
  assert.ok(ui.imageState.has(2), "new dock's frames now in the channel");
  assert.equal(ui.snapshot().selectedDock, 1);
  assert.equal(ui.imageChannel.imageFormat.get(2), 'bmp', 'replay keeps the frame format');
});

test('touch-strip frames: full resets, a window replaces its own region, snapshot in order', () => {
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
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
  touch.sendTouchSnapshot(
    (ui as unknown as { bus: { clients: Set<ServerWebSocket> } }).bus.clients.values().next()
      .value!,
  );
  const frames = sent.map((m) => JSON.parse(m) as { event: string; data: { data: string } });
  assert.deepEqual(
    frames.map((f) => [...Buffer.from(f.data.data, 'base64')][0]),
    [1, 3, 4],
    'full frame, then windows in paint order; the repainted window moved last',
  );
  assert.ok(frames.every((f) => f.event === 'touchImage'));

  sent.length = 0;
  touch.notifyDockTouchImage(0, new Uint8Array([5]));
  touch.notifyDockTouchImage(1, new Uint8Array([6]));
  assert.equal(sent.length, 1, 'only the selected dock broadcasts');
});

test('selecting an unknown/removed dock is rejected; unplug falls back to 0', () => {
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
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
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
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
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
  const before = ui.fullState().mockConfig.productId;
  const result = ui.applyMockConfig({ productId: Number.NaN });
  assert.equal(result.productId, before, 'productId unchanged for NaN');
});

test('valid integer productId is masked and applied', () => {
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
  const result = ui.applyMockConfig({ productId: 0x1234abcd });
  assert.equal(result.productId, 0x1234abcd & 0xffff, 'productId masked');
});

// WebUIServer: POST /api/image-mode

console.log('\nwebui: POST /api/image-mode');

const IMAGE_MODE_TEST_PORT = 13002;
const imageModeUi = new WebUIServer(IMAGE_MODE_TEST_PORT, [], 'real', TEST_SETTINGS_ROOT);
await imageModeUi.start();

try {
  const base = `http://127.0.0.1:${imageModeUi.port}`;

  async function postImageMode(mode: unknown): Promise<Response> {
    return fetch(`${base}/api/image-mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
  }

  test('initial imageModeOverride is null', () => {
    assert.equal(imageModeUi.fullState().imageModeOverride, null);
  });

  await runWebTest('valid mode "pad-edge" → 200 ok, reflected in fullState', async () => {
    const r = await postImageMode('pad-edge');
    assert.equal(r.status, 200);
    const body = (await r.json()) as { ok: unknown; mode: unknown };
    assert.ok(body.ok);
    assert.equal(body.mode, 'pad-edge');
    assert.equal(imageModeUi.fullState().imageModeOverride, 'pad-edge');
  });

  await runWebTest("valid mode 'default' → 200 ok, fullState override → null", async () => {
    const r = await postImageMode('default');
    assert.equal(r.status, 200);
    const body = (await r.json()) as { ok: unknown; mode: unknown };
    assert.ok(body.ok);
    assert.equal(body.mode, 'default');
    assert.equal(imageModeUi.fullState().imageModeOverride, null);
  });

  for (const mode of ['resize', 'pad-black', 'pad-average']) {
    await runWebTest(`valid mode '${mode}' → 200 ok, reflected in fullState`, async () => {
      const r = await postImageMode(mode);
      assert.equal(r.status, 200);
      assert.equal(imageModeUi.fullState().imageModeOverride, mode);
    });
  }

  await runWebTest('invalid mode string → 400', async () => {
    const r = await postImageMode('sideways');
    assert.equal(r.status, 400);
  });

  await runWebTest('non-string mode → 400', async () => {
    const r = await postImageMode(123);
    assert.equal(r.status, 400);
  });

  await runWebTest('invalid JSON body → 400', async () => {
    const r = await fetch(`${base}/api/image-mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    assert.equal(r.status, 400);
  });

  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

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
    },
  );

  await runWebTest('POST /api/touch-strip (removed) → 404', async () => {
    assert.equal((await post('/api/touch-strip', { disabled: true })).status, 404);
  });
} finally {
  await imageModeUi.stop().catch(() => undefined);
}

// WebUIServer: GET /api/image/:key content type by stored format

console.log('\nwebui: GET /api/image/:key content type');

const IMAGE_ROUTE_TEST_PORT = 13005;
const imageRouteUi = new WebUIServer(IMAGE_ROUTE_TEST_PORT, [], 'real', TEST_SETTINGS_ROOT);
await imageRouteUi.start();

try {
  const base = `http://127.0.0.1:${imageRouteUi.port}`;

  await runWebTest('jpeg frame → image/jpeg', async () => {
    imageRouteUi.imageChannel.notifyImageUpdate(0, Buffer.from([1, 2, 3]), 'jpeg');
    const r = await fetch(`${base}/api/image/0`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/jpeg');
  });

  await runWebTest('bmp frame → image/bmp', async () => {
    imageRouteUi.imageChannel.notifyImageUpdate(1, Buffer.from([4, 5, 6]), 'bmp');
    const r = await fetch(`${base}/api/image/1`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/bmp');
  });

  await runWebTest('missing key → 404', async () => {
    const r = await fetch(`${base}/api/image/99`);
    assert.equal(r.status, 404);
  });
} finally {
  await imageRouteUi.stop().catch(() => undefined);
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
    imageModeOverride: unknown;
    touchStripMode: unknown;
    touchStripRepaintMs: unknown;
    touchStripZoneFit: unknown;
    touchStripUpload: unknown;
    encoders: unknown;
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
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
  ui.getOrCreateDeviceIdentity('fake-device-0', 'Dock');
  ui.notifyDocks([{ ...fakeDockStatus(0), brightness: 33 }]);
  const parsed = JSON.parse(ui.getSettingsJson()) as { devices?: { brightness?: number }[] };
  assert.equal(
    parsed.devices?.[0]?.brightness,
    33,
    "entry brightness follows the dock's live value",
  );
});

test('applySettingsJson: devices[] import applies per-device override + imageMode to selected dock', () => {
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
  ui.notifyDocks([{ ...fakeDockStatus(0), brightness: 10 }]);
  ui.applySettingsJson(
    JSON.stringify({
      devices: [
        deviceEntry('fake-device-0', { brightnessOverride: true, imageModeOverride: 'pad-black' }),
      ],
    }),
  );
  assert.equal(ui.fullState().brightnessOverride, true, "selected dock's override resolved");
  assert.equal(ui.snapshot().imageModeOverride, 'pad-black', "selected dock's imageMode resolved");
});

test('applySettingsJson: null imageModeOverride on the selected device clears it', () => {
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
  ui.notifyDocks([fakeDockStatus(0)]);
  ui.applySettingsJson(
    JSON.stringify({ devices: [deviceEntry('fake-device-0', { imageModeOverride: 'pad-black' })] }),
  );
  assert.equal(ui.snapshot().imageModeOverride, 'pad-black');
  ui.applySettingsJson(
    JSON.stringify({ devices: [deviceEntry('fake-device-0', { imageModeOverride: null })] }),
  );
  assert.equal(ui.snapshot().imageModeOverride, null);
});

test('applySettingsJson: a device entry with an invalid imageModeOverride is rejected (guard), state unchanged', () => {
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
  ui.notifyDocks([fakeDockStatus(0)]);
  ui.applySettingsJson(
    JSON.stringify({
      devices: [deviceEntry('fake-device-0', { imageModeOverride: 'not-a-mode' })],
    }),
  );
  const parsed = JSON.parse(ui.getSettingsJson()) as { devices?: unknown[] };
  assert.ok(!parsed.devices || parsed.devices.length === 0, 'malformed entry not stored');
  assert.equal(ui.snapshot().imageModeOverride, null, 'runtime state unaffected');
});

test('applySettingsJson throws on malformed JSON, state unchanged', () => {
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
  ui.notifyDocks([{ ...fakeDockStatus(0), brightness: 20 }]);
  assert.throws(() => ui.applySettingsJson('not-json{{'));
  assert.equal(ui.snapshot().brightness, 20, 'brightness unchanged after rejected input');
});

test('applySettingsJson throws on a JSON array (not an object)', () => {
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
  assert.throws(() => ui.applySettingsJson('[1,2,3]'));
});

test('applySettingsJson: an unknown selectedDock is ignored, not fatal', () => {
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
  ui.notifyDocks([fakeDockStatus(0)]);
  ui.applySettingsJson(JSON.stringify({ selectedDock: 99 }));
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
  const ui = new WebUIServer(undefined, [], 'real', dir);
  const identity = ui.getOrCreateDeviceIdentity('/dev/hidraw3', 'My Dock');
  assert.equal(identity.deviceKey, '/dev/hidraw3');
  assert.equal(identity.mdnsServiceName, 'My Dock');

  const body = JSON.parse(ui.getSettingsJson()) as { devices?: { deviceKey: string }[] };
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
  const ui = new WebUIServer(undefined, [], 'real', dir);
  const first = ui.getOrCreateDeviceIdentity('/dev/hidraw3', 'My Dock');
  const second = ui.getOrCreateDeviceIdentity('/dev/hidraw3', 'A Different Default');
  assert.equal(second, first, 'same object reference — not regenerated');
  assert.equal(second.mdnsServiceName, 'My Dock', 'original name kept, default ignored on reuse');
});

test('updateDeviceMdnsName: renames an existing entry, returns true', () => {
  const dir = `${DEVICE_IDENTITY_TEST_ROOT}/rename`;
  const ui = new WebUIServer(undefined, [], 'real', dir);
  ui.getOrCreateDeviceIdentity('/dev/hidraw3', 'My Dock');
  const ok = ui.updateDeviceMdnsName('/dev/hidraw3', 'Renamed Dock');
  assert.equal(ok, true);
  assert.equal(
    ui.getOrCreateDeviceIdentity('/dev/hidraw3', 'ignored').mdnsServiceName,
    'Renamed Dock',
  );
});

test('updateDeviceMdnsName: unknown deviceKey returns false, no-op', () => {
  const dir = `${DEVICE_IDENTITY_TEST_ROOT}/unknown`;
  const ui = new WebUIServer(undefined, [], 'real', dir);
  const ok = ui.updateDeviceMdnsName('/dev/nonexistent', 'Whatever');
  assert.equal(ok, false);
});

// WebUIServer: POST /api/device-identity/mdns-name

console.log('\nwebui: POST /api/device-identity/mdns-name');

const MDNS_ROUTE_TEST_PORT = 13004;
const mdnsRouteUi = new WebUIServer(
  MDNS_ROUTE_TEST_PORT,
  [],
  'real',
  `${DEVICE_IDENTITY_TEST_ROOT}/route`,
);
await mdnsRouteUi.start();

try {
  const base = `http://127.0.0.1:${mdnsRouteUi.port}`;

  await runWebTest('valid body → 200, emits setDeviceMdnsName with trimmed name', async () => {
    let emitted: unknown[] | null = null;
    mdnsRouteUi.on('setDeviceMdnsName', (...args: unknown[]) => {
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

// WebUIServer: GET/POST /api/settings

console.log('\nwebui: GET/POST /api/settings');

const SETTINGS_TEST_PORT = 13003;
const settingsUi = new WebUIServer(SETTINGS_TEST_PORT, [], 'real', TEST_SETTINGS_ROOT);
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
    const back = JSON.parse(settingsUi.getSettingsJson()) as {
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
  const ui = new WebUIServer(PRUNE_TEST_PORT, [], 'real', PRUNE_ROOT);
  await ui.start();
  try {
    const body = JSON.parse(ui.getSettingsJson()) as { devices?: { deviceKey: string }[] };
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
    const ui = new WebUIServer(undefined, [], 'real', PRUNE_ROOT);
    await ui.start(false);
    const body = JSON.parse(ui.getSettingsJson()) as { devices?: Record<string, unknown>[] };
    assert.equal(body.devices?.length, 1, 'identity entry survives (no Elgato re-pair)');
    const entry = body.devices![0]!;
    assert.equal(entry.brightness, 42);
    for (const k of ['touchStripMode', 'encoders', 'touchStripDisabled']) {
      assert.ok(!(k in entry), `${k} stripped`);
    }
    assert.equal(ui.touchStripModeFor('usb:0300D0782F51'), 'elgato');
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
    const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
    for (const [modelId, defaultEnabled] of [
      ['mirabox-293s', true],
      ['ajazz-akp153', false],
    ] as const) {
      ui.tryResetModelOverride(modelId);
      const initial = ui.deviceOverridesView(modelId);
      assert.ok(!('error' in initial));
      if ('error' in initial) continue;
      assert.equal(initial.tunable.wire!.batchImageTransfers, defaultEnabled);
      assert.ok(
        !(
          'error' in
          ui.trySetModelOverride(modelId, { wire: { batchImageTransfers: !defaultEnabled } })
        ),
        'batching toggles on a supported board',
      );
      const saved = ui.deviceOverridesView(modelId);
      assert.ok(!('error' in saved));
      if (!('error' in saved))
        assert.equal(saved.effective.wire.batchImageTransfers, !defaultEnabled);
      const importRoot = `${TEST_SETTINGS_ROOT}-batch-import`;
      await saveSettings(JSON.parse(ui.getSettingsJson()) as Settings, importRoot);
      const restoredUi = new WebUIServer(undefined, [], 'real', importRoot);
      await restoredUi.start(false);
      const persisted = restoredUi.deviceOverridesView(modelId);
      assert.ok(!('error' in persisted));
      if (!('error' in persisted))
        assert.equal(persisted.tunable.wire?.batchImageTransfers, !defaultEnabled);
      await restoredUi.stop();
      ui.tryResetModelOverride(modelId);
      const reset = ui.deviceOverridesView(modelId);
      if (!('error' in reset))
        assert.equal(reset.tunable.wire?.batchImageTransfers, defaultEnabled);
    }
    assert.ok(
      'error' in ui.trySetModelOverride('fifine-d6', { wire: { batchImageTransfers: true } }),
      'batching is rejected on a model without the 293S board',
    );
  },
);

test('device-overrides view seeds from the registry when nothing is persisted', () => {
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
  const view = ui.deviceOverridesView(TUNED_MODEL);
  assert.ok(!('error' in view), 'known model resolves');
  if (!('error' in view)) {
    assert.equal(view.modelId, TUNED_MODEL);
    assert.deepEqual(view.overrides, {}, 'nothing tuned yet');
    assert.equal(view.effective.image.rotate, view.defaults.image?.rotate, 'effective = default');
  }
});

test('device-overrides default view follows the selected dock', () => {
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
  ui.notifyDocks([
    { ...fakeDockStatus(0), modelId: TUNED_MODEL },
    { ...fakeDockStatus(1), modelId: 'mirabox-293s', modelName: 'Mirabox 293S' },
  ]);
  ui.selectDock(1);
  const view = ui.deviceOverridesView();
  assert.ok(!('error' in view));
  if (!('error' in view)) assert.equal(view.modelId, 'mirabox-293s');
});

test('the form seed round-trips: POSTing `tunable` unchanged is accepted', () => {
  // Regression: the panel used to seed from `effective`, which carries the
  // non-tunable protocol facts (format/colorMode/bmpPpm) as well — so pressing
  // Apply without touching anything failed with "image.format: unknown field".
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
  for (const modelId of [
    'mk2',
    'mini',
    TUNED_MODEL,
    'mirabox-k1pro',
    'fifine-d6',
    'ajazz-akp153',
  ]) {
    const view = ui.deviceOverridesView(modelId);
    assert.ok(!('error' in view), `${modelId} resolves`);
    if ('error' in view) continue;
    assert.ok(
      !('error' in ui.trySetModelOverride(modelId, view.tunable)),
      `${modelId}: the seed the UI renders must be a valid override`,
    );
    ui.tryResetModelOverride(modelId);
  }
});

test('`tunable` excludes the protocol facts `effective` exposes', () => {
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
  const view = ui.deviceOverridesView('mk2');
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
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
  const view = ui.deviceOverridesView(TUNED_MODEL);
  assert.ok(!('error' in view));
  if ('error' in view) return;
  const edited = { ...view.overrides, image: { ...view.tunable.image, rotate: 90 as const } };
  assert.ok(!('error' in ui.trySetModelOverride(TUNED_MODEL, edited)), 'the edited seed applies');
  const after = ui.deviceOverridesView(TUNED_MODEL);
  assert.ok(!('error' in after) && after.effective.image.rotate === 90);
  ui.tryResetModelOverride(TUNED_MODEL);
});

test('device-overrides view 404s on an unknown model id', () => {
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
  const view = ui.deviceOverridesView('not-a-model');
  assert.ok('error' in view && view.status === 404, 'unknown id is a 404, not a crash');
});

test('a valid override persists and shows up in the effective spec', () => {
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
  assert.deepEqual(ui.trySetModelOverride(TUNED_MODEL, { image: { rotate: 180 } }), {
    kind: 'live',
  });
  const view = ui.deviceOverridesView(TUNED_MODEL);
  assert.ok(!('error' in view));
  if (!('error' in view)) assert.equal(view.effective.image.rotate, 180);
  const parsed = JSON.parse(ui.getSettingsJson()) as {
    modelOverrides?: Record<string, { image?: { rotate?: number } }>;
  };
  assert.equal(parsed.modelOverrides?.[TUNED_MODEL]?.image?.rotate, 180, 'written to settings');
});

test('an invalid override is rejected with the full error list, nothing persisted', () => {
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
  const r = ui.trySetModelOverride(TUNED_MODEL, { image: { rotate: 45, quality: 9 } });
  const err = 'error' in r ? r : null;
  assert.ok(err !== null, 'rejected');
  assert.equal(err?.status, 400);
  assert.ok(err?.error.includes('image.rotate'), err?.error);
  assert.ok(err?.error.includes('image.quality'), 'every bad field is reported at once');
  assert.equal(ui.modelOverrideFor(TUNED_MODEL), undefined, 'nothing stored');
});

test('reset clears the override', () => {
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
  ui.trySetModelOverride(TUNED_MODEL, { image: { rotate: 90 } });
  assert.ok(ui.modelOverrideFor(TUNED_MODEL) !== undefined, 'precondition: tuned');
  assert.deepEqual(ui.tryResetModelOverride(TUNED_MODEL), { kind: 'live' });
  assert.equal(ui.modelOverrideFor(TUNED_MODEL), undefined);
});

test('applySettingsJson imports modelOverrides and drops invalid entries', () => {
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
  ui.applySettingsJson(
    JSON.stringify({
      modelOverrides: {
        [TUNED_MODEL]: { image: { rotate: 270 } },
        'not-a-model': { image: { rotate: 90 } },
        'mirabox-293s': { image: { rotate: 45 } },
      },
    }),
  );
  assert.equal(ui.modelOverrideFor(TUNED_MODEL)?.image?.rotate, 270, 'valid entry kept');
  assert.equal(ui.modelOverrideFor('not-a-model'), undefined, 'unknown model dropped');
  assert.equal(ui.modelOverrideFor('mirabox-293s'), undefined, 'invalid override dropped');
});

test('safe mode reports the registry defaults as effective, but keeps the override', () => {
  // The one time a user opens this panel is when a bad override made the device
  // look dead — a view that disagreed with the hardware would mislead them. The
  // stored value stays so Reset still works.
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
  ui.trySetModelOverride(TUNED_MODEL, { image: { rotate: 180 } });
  const before = ui.deviceOverridesView(TUNED_MODEL);
  assert.ok(!('error' in before) && before.effective.image.rotate === 180, 'precondition');

  tjs.env.DECKBRIDGE_NO_OVERRIDES = '1';
  try {
    const view = ui.deviceOverridesView(TUNED_MODEL);
    assert.ok(!('error' in view));
    if (!('error' in view)) {
      assert.equal(view.safeMode, true, 'the UI can say so');
      assert.equal(view.effective.image.rotate, 0, 'effective = what the device runs');
      assert.equal(view.overrides.image?.rotate, 180, 'the override is still stored');
    }
  } finally {
    delete tjs.env.DECKBRIDGE_NO_OVERRIDES;
  }
  ui.tryResetModelOverride(TUNED_MODEL);
});

test('trySetLogLevel validates and persists', () => {
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
  assert.equal(ui.trySetLogLevel('debug'), null);
  assert.equal(ui.logLevel(), 'debug', 'applied to the main thread');
  const parsed = JSON.parse(ui.getSettingsJson()) as { logLevel?: string };
  assert.equal(parsed.logLevel, 'debug', 'written to settings');
  const err = ui.trySetLogLevel('loud');
  assert.equal(err?.status, 400);
  assert.equal(ui.logLevel(), 'debug', 'a rejected level does not change anything');
  ui.trySetLogLevel('warn'); // restore: setLogLevel is process-wide
});

test('fullState exposes the log level and log path for the Settings page', () => {
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
  const state = ui.fullState();
  assert.equal(typeof state.logLevel, 'string');
  assert.ok(state.logFilePath.endsWith('deckbridge.log'), state.logFilePath);
});

test('fullState omits logs/commLogs in simple-only builds (the test build default)', () => {
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
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
    const ui = new WebUIServer(undefined, [], 'real', root);
    await ui.start(false); // load settings without binding a port
    assert.equal(ui.modelOverrideFor(TUNED_MODEL)?.image?.rotate, 180, 'valid entry survives');
    assert.equal(ui.modelOverrideFor('mirabox-293s'), undefined, 'invalid entry dropped');
    await tjs.remove(root, { recursive: true }).catch(() => undefined);
  },
);

// Summary

summaryExit();
