import assert from 'tjs:assert';
import {
  isAllowedWebRequest,
  isValidMacAddress,
  pickFallbackPort,
  WebUIServer,
} from '../src/web/server/web-ui-server.js';
import { Broadcaster } from '../src/web/server/broadcaster.js';
import { saveSettings } from '../src/settings-store.js';
import type { DockStatus } from '../src/types.js';

// Isolate settings.json writes from the real user cache dir — every mutator
// that touches a persisted field now writes to disk (see settings-store.ts).
const TEST_SETTINGS_ROOT = `${tjs.tmpDir}/webui-server-test-settings-${tjs.pid}`;

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

async function runWebTest(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

// ── isValidMacAddress ─────────────────────────────────────────────────────────

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

// ── isAllowedWebRequest ────────────────────────────────────────────────────────

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

// ── pickFallbackPort ──────────────────────────────────────────────────────────

console.log('\npickFallbackPort');

test('returns a port in the expected fallback range', () => {
  for (let i = 0; i < 50; i++) {
    const port = pickFallbackPort();
    assert.ok(port >= 64000 && port <= 65000, `port ${port} out of range`);
  }
});

// ── Broadcaster.size ──────────────────────────────────────────────────────────

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

// ── WebUIServer.resetImages ──────────────────────────────────────────────────

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

// ── WebUIServer.notifyDocks ──────────────────────────────────────────────────

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

test('notifyDocks broadcasts status + extra-key configs to a connected WS client', () => {
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
  const { sent } = connectMockClient(ui);
  sent.length = 0; // discard the initial-connect snapshot

  ui.notifyDocks([fakeDockStatus(0)]);

  // status + extraKeys: the selected dock's live deviceKey may have changed, so
  // notifyDocks re-pushes its extra-key configs alongside the status snapshot.
  assert.equal(sent.length, 2, 'status + extraKeys broadcast');
  const parsed = JSON.parse(sent[0]!) as { event: string; data: { docks: DockStatus[] } };
  assert.equal(parsed.event, 'status');
  assert.equal(parsed.data.docks.length, 1);
  assert.equal(parsed.data.docks[0]!.index, 0);
  assert.equal((JSON.parse(sent[1]!) as { event: string }).event, 'extraKeys');
});

test('duplicate notifyDocks call (same shape) does not broadcast again', () => {
  const ui = new WebUIServer(undefined, [], 'real', TEST_SETTINGS_ROOT);
  const { sent } = connectMockClient(ui);
  sent.length = 0;

  ui.notifyDocks([fakeDockStatus(0)]);
  assert.equal(sent.length, 2, 'first call broadcasts status + extraKeys');

  ui.notifyDocks([fakeDockStatus(0)]); // new array, same JSON shape
  assert.equal(sent.length, 2, 'duplicate call is deduped — no further broadcast');

  ui.notifyDocks([fakeDockStatus(0), fakeDockStatus(1)]);
  assert.equal(sent.length, 4, 'a genuinely different list broadcasts status + extraKeys again');
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

// ── WebUIServer selected-dock preview mirror ─────────────────────────────────

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
  assert.equal(ui.imageFormat.get(2), 'bmp', 'replay keeps the frame format');
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

// ── WebUIServer.applyMockConfig productId ────────────────────────────────────

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

// ── WebUIServer: POST /api/image-mode ────────────────────────────────────────

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
} finally {
  await imageModeUi.stop().catch(() => undefined);
}

// ── WebUIServer settings persistence ─────────────────────────────────────────

console.log('\nWebUIServer.getSettingsJson / applySettingsJson');

/** A well-formed devices[] entry for `deviceKey` with optional per-device
 *  settings merged in (identity fields match fakeDockStatus's deviceKey). */
function deviceEntry(
  deviceKey: string,
  settings: Partial<{
    brightness: number;
    brightnessOverride: boolean;
    imageModeOverride: unknown;
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

// ── WebUIServer device identity (getOrCreateDeviceIdentity / updateDeviceMdnsName) ──

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

// ── WebUIServer: POST /api/device-identity/mdns-name ─────────────────────────

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

// ── WebUIServer: GET/POST /api/settings ──────────────────────────────────────

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

// ── WebUIServer: load-time prune of legacy path-keyed entries ────────────────

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

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
tjs.exit(failed > 0 ? 1 : 0);
