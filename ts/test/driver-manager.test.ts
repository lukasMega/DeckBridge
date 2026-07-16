import assert from 'tjs:assert';
import { EventEmitter } from '../src/platform/events-shim.js';
import { DriverManager } from '../src/driver-manager.js';
import { DEFAULT_MODEL, DEVICE_MODELS } from '../src/devices/registry.js';
import { MIRABOX_293_MODEL } from '../src/devices/mirabox/mirabox-293.js';
import { MIRABOX_293S_MODEL } from '../src/devices/mirabox/mirabox-293s.js';
import { MIRABOX_K1PRO_MODEL } from '../src/devices/mirabox/mirabox-k1pro.js';
import type { SessionIdentity, SessionServers } from '../src/device-session.js';
import type { DeviceModel } from '../src/devices/driver.js';
import type { CommEntry, KeyState } from '../src/types.js';
import { ELGATO_TCP_PORT } from '../src/types.js';
import type { ChildGeometry } from '../src/capabilities.js';
import type { DeviceConfig } from '../src/elgato-types.js';
import type { ElgatoServer, ElgatoChildServer } from '../src/elgato.js';
import type { WebUIServer } from '../src/web/server/index.js';
import type { WorkerHidDriver } from '../src/hid-worker-host.js';
import { generateDeviceIdentity } from '../src/device-identity.js';
import type { DeviceIdentitySettings } from '../src/settings-store.js';

// ── Test harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e: unknown) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

// ── Fakes ────────────────────────────────────────────────────────────────────

function makeFakeServer() {
  return {
    setDeviceConfigCalls: [] as Partial<DeviceConfig>[],
    setChildGeometryCalls: [] as ChildGeometry[],
    restartMdnsCalls: [] as number[],
    pushChildCapabilitiesCalls: 0,
    setMdnsServiceNameCalls: [] as string[],
    setDeviceConfig(config: Partial<DeviceConfig>) {
      this.setDeviceConfigCalls.push(config);
    },
    setChildGeometry(geo: ChildGeometry) {
      this.setChildGeometryCalls.push(geo);
    },
    restartMdns(productId: number) {
      this.restartMdnsCalls.push(productId);
    },
    pushChildCapabilities() {
      this.pushChildCapabilitiesCalls++;
    },
    setMdnsServiceName(name: string) {
      this.setMdnsServiceNameCalls.push(name);
    },
  };
}

function makeFakeChildServer() {
  return {
    setChildGeometryCalls: [] as ChildGeometry[],
    sendKeyEventCalls: [] as { keyIndex: number; state: KeyState }[],
    hasClient: false,
    setChildGeometry(geo: ChildGeometry) {
      this.setChildGeometryCalls.push(geo);
    },
    sendKeyEvent(keyIndex: number, state: KeyState) {
      this.sendKeyEventCalls.push({ keyIndex, state });
    },
  };
}

function makeFakeWebUI() {
  return {
    notifyDeviceModelCalls: [] as {
      id: string;
      name: string;
      keyCount: number;
      columns: number;
      rows: number;
    }[],
    notifyKeyEventCalls: [] as { mk2Index: number; state: KeyState }[],
    notifyDriverStatusCalls: [] as { mode: string; connected: boolean }[],
    notifyCommCalls: [] as Omit<CommEntry, 'ts'>[],
    resetImagesCalls: 0,
    resetImages() {
      this.resetImagesCalls++;
    },
    notifyDeviceModel(model: {
      id: string;
      name: string;
      keyCount: number;
      columns: number;
      rows: number;
    }) {
      this.notifyDeviceModelCalls.push(model);
    },
    notifyKeyEvent(mk2Index: number, state: KeyState) {
      this.notifyKeyEventCalls.push({ mk2Index, state });
    },
    notifyDriverStatus(mode: string, connected: boolean) {
      this.notifyDriverStatusCalls.push({ mode, connected });
    },
    notifyElgatoDevicePresentCalls: [] as boolean[],
    notifyElgatoDevicePresent(present: boolean) {
      this.notifyElgatoDevicePresentCalls.push(present);
    },
    notifyComm(entry: Omit<CommEntry, 'ts'>) {
      this.notifyCommCalls.push(entry);
    },
    devices: [] as DeviceIdentitySettings[],
    // Per-device brightness override, resolved by the coordinator per dock. No
    // dock has a persisted override in these tests → default.
    isBrightnessOverride(_deviceKey: string): boolean {
      return false;
    },
    getOrCreateDeviceIdentityCalls: [] as { deviceKey: string; defaultMdnsName: string }[],
    // Mirrors WebUIServer.getOrCreateDeviceIdentity: lookup-or-generate + memoize,
    // so tests exercising a reconnect/rescan see a stable identity like production.
    getOrCreateDeviceIdentity(deviceKey: string, defaultMdnsName: string): DeviceIdentitySettings {
      this.getOrCreateDeviceIdentityCalls.push({ deviceKey, defaultMdnsName });
      const existing = this.devices.find((d) => d.deviceKey === deviceKey);
      if (existing) return existing;
      const identity = generateDeviceIdentity(deviceKey, defaultMdnsName);
      this.devices.push(identity);
      return identity;
    },
    // Raw per-dock CORA frame cache the app pushed; dockFramesSnapshot reads it
    // (as WebUIServer does) so a test can simulate frames present at disconnect.
    dockFrames: new Map<number, Map<number, { data: Uint8Array; format: 'jpeg' | 'bmp' }>>(),
    dockFramesSnapshot(dock: number) {
      return new Map(this.dockFrames.get(dock) ?? []);
    },
    notifyDockImageCalls: [] as { dock: number; key: number; format: string }[],
    notifyDockImage(dock: number, key: number, _data: unknown, format: 'jpeg' | 'bmp' = 'jpeg') {
      this.notifyDockImageCalls.push({ dock, key, format });
    },
  };
}

/** A fake "real" driver whose open() rejects while `toggleFailOpen` is true and
 *  resolves once it is flipped false. Models a present-but-unopenable device
 *  (e.g. Input Monitoring denied) that later becomes openable, exercising the
 *  reused-worker reconnect path: open() is retried on the SAME instance, so the
 *  flag flip — not a factory swap — is what turns failure into success. */
let toggleFailOpen = true;
class ToggleRealDriver extends EventEmitter {
  readonly model: DeviceModel;
  deviceSerial: string | undefined = 'SN123';
  deviceFirmware: string | undefined = '1.0';

  constructor(model: DeviceModel) {
    super();
    this.model = model;
  }

  open(): Promise<void> {
    return toggleFailOpen ? Promise.reject(new Error('no device')) : Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  sendImage(): void {}
  clearKey(): void {}
  setBrightness(): void {}
}

/**
 * A fake "real" driver whose open() resolves only when the test calls
 * `resolveOpen()`, via a `Promise.withResolvers()` deferred. Lets a test pause
 * mid-probe to exercise the post-await state re-check (E1-a) and the
 * in-flight probe guard (E1-b).
 */
class ControllableRealDriver extends EventEmitter {
  readonly model: DeviceModel;
  deviceSerial: string | undefined = 'SN999';
  deviceFirmware: string | undefined = '1.0';
  closeCalls = 0;

  private readonly deferred = Promise.withResolvers<void>();

  constructor(model: DeviceModel) {
    super();
    this.model = model;
  }

  open(): Promise<void> {
    return this.deferred.promise;
  }

  resolveOpen(): void {
    this.deferred.resolve();
  }

  close(): Promise<void> {
    this.closeCalls++;
    return Promise.resolve();
  }

  sendImage(): void {}
  clearKey(): void {}
  setBrightness(): void {}
}

/** A fake "real" driver that records renderCoraImage/sendSplashImage calls, so a
 *  test can assert the deck is repainted from the app's cached frames on replug. */
class RepaintFakeDriver extends EventEmitter {
  readonly model: DeviceModel;
  deviceSerial: string | undefined = 'SNIMG';
  deviceFirmware: string | undefined = '1.0';
  hidPath: string | undefined = undefined;
  renderCoraImageCalls: { key: number; format: string }[] = [];
  sendSplashImageCalls = 0;

  constructor(model: DeviceModel) {
    super();
    this.model = model;
  }

  open(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
  sendImage(): void {}
  clearKey(): void {}
  setBrightness(): void {}
  setImageOverride(): void {}
  renderCoraImage(key: number, _bytes: unknown, format: 'jpeg' | 'bmp'): void {
    this.renderCoraImageCalls.push({ key, format });
  }
  sendSplashImage(): void {
    this.sendSplashImageCalls++;
  }
}

function setup() {
  const server = makeFakeServer();
  const childServer = makeFakeChildServer();
  const webui = makeFakeWebUI();
  const driverManager = new DriverManager({
    webui: webui as unknown as WebUIServer,
    server: server as unknown as ElgatoServer,
    childServer: childServer as unknown as ElgatoChildServer,
    onTrayChange: () => {},
    getShuttingDown: () => false,
  });
  // No real FFI/hardware in tests: treat every model as present so probeAndOpen()
  // still exercises the injected fake-driver open() path. The real presence check
  // (deckbridge-native enumeration) is covered at runtime, not here.
  driverManager.__setPresenceCheck(() => true);
  return { server, childServer, webui, driverManager };
}

// ── Tests ────────────────────────────────────────────────────────────────────

// NOTE: each test gets its own DriverManager instance via setup(), so
// driverMode always starts at its default ('real' unless DECKBRIDGE_MOCK=1) —
// tryRealConnect() is a no-op unless driverMode === 'real'.
await test('6. getReconnectAttemptCount increments across failed tryRealConnect, resets on success', async () => {
  const { driverManager } = setup();
  assert.equal(
    driverManager.getDriverMode(),
    'real',
    'driver mode is real by default (precondition)',
  );

  toggleFailOpen = true;
  driverManager.__setRealDriverFactory(
    (model) => new ToggleRealDriver(model) as unknown as WorkerHidDriver,
  );
  try {
    assert.equal(driverManager.getReconnectAttemptCount(), 0, 'starts at 0');

    // tryRealConnect (mode 'real' by default) probes all models; all fail to open.
    // On failure it calls scheduleReconnect(), which increments the counter and
    // schedules another tryRealConnect via setTimeout — we don't wait for that timer.
    await driverManager.tryRealConnect();
    assert.equal(
      driverManager.getReconnectAttemptCount(),
      1,
      'attempt count incremented after first failed probe',
    );

    await driverManager.tryRealConnect();
    assert.equal(
      driverManager.getReconnectAttemptCount(),
      2,
      'attempt count incremented after second failed probe',
    );

    // Device becomes openable (e.g. Input Monitoring granted): the SAME reused
    // worker's next open() now succeeds -> reconnectAttemptCount resets to 0.
    // No factory swap — reuse means a fresh driver is never created here.
    toggleFailOpen = false;
    await driverManager.tryRealConnect();
    assert.equal(
      driverManager.getReconnectAttemptCount(),
      0,
      'attempt count resets to 0 on successful connect',
    );
  } finally {
    driverManager.__resetRealDriverFactory();
  }
});

await test("7. replug repaints the deck from the app's last CORA frames (over the splash)", async () => {
  const { webui, driverManager } = setup();
  const created: RepaintFakeDriver[] = [];
  driverManager.__setRealDriverFactory((model) => {
    const d = new RepaintFakeDriver(model);
    created.push(d);
    return d as unknown as WorkerHidDriver;
  });
  try {
    // First connect: no frames captured yet, so nothing is replayed.
    await driverManager.tryRealConnect();
    const first = created[0]!;
    assert.equal(first.renderCoraImageCalls.length, 0, 'no replay on the first connect');

    // The Elgato app pushed frames for two keys (cached on dock 0).
    webui.dockFrames.set(
      0,
      new Map([
        [0, { data: new Uint8Array([1]), format: 'jpeg' }],
        [3, { data: new Uint8Array([2]), format: 'bmp' }],
      ]),
    );

    // USB unplug: the disconnect handler snapshots the frames before the wipe.
    first.emit('disconnect');
    assert.equal(driverManager.getCurrentDriver(), null, 'driver cleared on disconnect');

    // USB replug: the same model reconnects.
    await driverManager.tryRealConnect();
    const second = created[1]!;
    assert.notEqual(second, first, 'a fresh driver instance after replug');

    // The deck is repainted with the app's last frames (the app never re-pushes).
    assert.equal(second.renderCoraImageCalls.length, 2, 'both cached frames replayed to the deck');
    assert.deepEqual(
      second.renderCoraImageCalls.map((c) => c.key).toSorted((a, b) => a - b),
      [0, 3],
      'the exact cached keys were repainted',
    );
    // The WebUI preview cache is repopulated too.
    assert.equal(
      webui.notifyDockImageCalls.filter((c) => c.dock === 0).length,
      2,
      'the WebUI preview is restored on replug',
    );
  } finally {
    driverManager.__resetRealDriverFactory();
  }
});

await test('1. connectMock(model) -> applyDeviceModel pushes PID, geometry, WebUI model notify', async () => {
  const { server, childServer, webui, driverManager } = setup();

  await driverManager.connectMock(DEFAULT_MODEL);

  assert.equal(
    driverManager.getDriverMode() === 'mock' || driverManager.getCurrentDriver() != null,
    true,
    'mock driver active',
  );
  assert.ok(driverManager.getCurrentDriver() != null, 'currentDriver set after connectMock');

  assert.equal(server.setDeviceConfigCalls.length, 1, 'setDeviceConfig called once');
  assert.equal(
    server.setDeviceConfigCalls[0]?.productId,
    DEFAULT_MODEL.cora.productId,
    'PID matches model',
  );

  // MK.2 (DEFAULT_MODEL) has no advertiseGeometry override; geometry is derived
  // from the model's own dimensions via modelToChildGeometry().
  assert.equal(server.setChildGeometryCalls.length, 1, 'server.setChildGeometry called once');
  assert.equal(
    childServer.setChildGeometryCalls.length,
    1,
    'childServer.setChildGeometry called once',
  );
  const geo = server.setChildGeometryCalls[0];
  assert.equal(geo?.keyCount, DEFAULT_MODEL.keyCount, 'geometry keyCount matches DEFAULT_MODEL');
  assert.equal(geo?.columns, DEFAULT_MODEL.columns, 'geometry columns matches DEFAULT_MODEL');
  assert.equal(geo?.rows, DEFAULT_MODEL.rows, 'geometry rows matches DEFAULT_MODEL');

  assert.equal(server.restartMdnsCalls.length, 1, 'restartMdns called once');
  assert.equal(
    server.restartMdnsCalls[0],
    DEFAULT_MODEL.cora.productId,
    'restartMdns called with model PID',
  );
  assert.equal(server.pushChildCapabilitiesCalls, 1, 'pushChildCapabilities called once');

  assert.equal(webui.notifyDeviceModelCalls.length, 1, 'webui.notifyDeviceModel called once');
  const notified = webui.notifyDeviceModelCalls[0];
  assert.equal(notified?.id, DEFAULT_MODEL.id, 'notified model id matches');
  assert.equal(notified?.keyCount, DEFAULT_MODEL.keyCount, 'notified keyCount matches');
  assert.equal(notified?.columns, DEFAULT_MODEL.columns, 'notified columns matches');
  assert.equal(notified?.rows, DEFAULT_MODEL.rows, 'notified rows matches');

  assert.equal(webui.notifyDriverStatusCalls.length, 1, 'webui.notifyDriverStatus called once');
  assert.equal(webui.notifyDriverStatusCalls[0]?.mode, 'mock', 'driver status mode is mock');
  assert.equal(webui.notifyDriverStatusCalls[0]?.connected, true, 'driver status connected true');
});

await test("2. Mock 'key' event -> childServer.sendKeyEvent + webui.notifyKeyEvent", async () => {
  const { childServer, webui, driverManager } = setup();

  await driverManager.connectMock(DEFAULT_MODEL);
  const driver = driverManager.getCurrentDriver();
  assert.ok(driver != null, 'driver present');

  driver?.emit('key', { keyIndex: 3, state: 'down' });

  assert.equal(childServer.sendKeyEventCalls.length, 1, 'sendKeyEvent called once');
  assert.equal(childServer.sendKeyEventCalls[0]?.keyIndex, 3, 'sendKeyEvent keyIndex matches');
  assert.equal(childServer.sendKeyEventCalls[0]?.state, 'down', 'sendKeyEvent state matches');

  assert.equal(webui.notifyKeyEventCalls.length, 1, 'notifyKeyEvent called once');
  assert.equal(webui.notifyKeyEventCalls[0]?.mk2Index, 3, 'notifyKeyEvent index matches');
  assert.equal(webui.notifyKeyEventCalls[0]?.state, 'down', 'notifyKeyEvent state matches');
});

await test("3. switchMode('mock') then connectMock() again -> old mock driver closed exactly once", async () => {
  const { driverManager } = setup();

  // switchMode('mock') sets driverMode='mock' and creates the first mock driver.
  // A second switchMode('mock') is a no-op while currentDriver is set (early
  // return in switchMode), so the "replace the active mock driver" path that
  // closes the old driver lives in connectMock() itself — call it directly,
  // as driver-manager does when re-applying a model while already in mock mode.
  await driverManager.switchMode('mock');
  const first = driverManager.getCurrentDriver();
  assert.ok(first != null, 'first mock driver created');
  assert.equal(driverManager.getDriverMode(), 'mock', 'driver mode is mock after switchMode');

  let closeCalls = 0;
  const origClose = first!.close.bind(first);
  first!.close = () => {
    closeCalls++;
    return origClose();
  };

  await driverManager.connectMock();
  const second = driverManager.getCurrentDriver();
  assert.ok(second != null, 'second mock driver created');
  assert.notEqual(second, first, 'a new mock driver replaces the old one');
  assert.equal(closeCalls, 1, 'old mock driver close() called exactly once');
});

await test('4. applyDeviceModel(MIRABOX_293S_MODEL) -> advertises MK.2 geometry/PID per its cora config', () => {
  const { server, childServer, webui, driverManager } = setup();

  driverManager.applyDeviceModel(MIRABOX_293S_MODEL);

  const expectedGeo = MIRABOX_293S_MODEL.cora.advertiseGeometry;
  assert.ok(expectedGeo != null, '293S model declares an advertiseGeometry');

  assert.equal(server.setDeviceConfigCalls.length, 1, 'setDeviceConfig called once');
  assert.equal(
    server.setDeviceConfigCalls[0]?.productId,
    MIRABOX_293S_MODEL.cora.productId,
    'advertised PID matches 293S cora.productId (MK.2 PID)',
  );

  assert.equal(server.setChildGeometryCalls.length, 1, 'server.setChildGeometry called once');
  assert.deepEqual(
    server.setChildGeometryCalls[0],
    expectedGeo,
    'server geometry matches advertiseGeometry',
  );
  assert.equal(
    childServer.setChildGeometryCalls.length,
    1,
    'childServer.setChildGeometry called once',
  );
  assert.deepEqual(
    childServer.setChildGeometryCalls[0],
    expectedGeo,
    'childServer geometry matches advertiseGeometry',
  );

  assert.equal(
    server.restartMdnsCalls[0],
    MIRABOX_293S_MODEL.cora.productId,
    'restartMdns with 293S PID',
  );
  assert.equal(server.pushChildCapabilitiesCalls, 1, 'pushChildCapabilities called once');

  assert.equal(webui.notifyDeviceModelCalls.length, 1, 'webui notified once');
  const notified = webui.notifyDeviceModelCalls[0];
  assert.equal(notified?.id, MIRABOX_293S_MODEL.id, 'notified id is 293s');
  assert.equal(
    notified?.keyCount,
    expectedGeo?.keyCount,
    'notified keyCount matches advertiseGeometry',
  );
  assert.equal(
    notified?.columns,
    expectedGeo?.columns,
    'notified columns matches advertiseGeometry',
  );
  assert.equal(notified?.rows, expectedGeo?.rows, 'notified rows matches advertiseGeometry');
});

await test('5. 293S key drop: a wire code mapping to -1 produces no sendKeyEvent', () => {
  const { childServer, webui } = setup();

  // Replicate the relevant slice of probeAndOpen's 'key' handler for a model
  // with an input keyMap (driver-manager.ts ~line 96-112): wire codes that map
  // to -1 via wireInputToCora must be dropped before reaching sendKeyEvent.
  const model = MIRABOX_293S_MODEL;
  const wireInputToCora = model.keyMap.wireInputToCora;
  assert.ok(wireInputToCora != null, '293S declares wireInputToCora');

  // Find a wire code that maps to -1 (the unused 6th column).
  const droppedWireCode = wireInputToCora!.findIndex((v) => v === -1);
  assert.ok(droppedWireCode >= 0, 'there is at least one -1 entry in wireInputToCora');

  const fakeDriver = new EventEmitter();
  fakeDriver.on('key', (e: { keyIndex: number; state: KeyState }) => {
    const mk2 = wireInputToCora![e.keyIndex] ?? -1;
    if (mk2 < 0) return; // unused 293S 6th-column key
    childServer.sendKeyEvent(mk2, e.state);
    webui.notifyKeyEvent(mk2, e.state);
  });

  fakeDriver.emit('key', { keyIndex: droppedWireCode, state: 'down' });

  assert.equal(
    childServer.sendKeyEventCalls.length,
    0,
    'no sendKeyEvent for dropped 6th-column key',
  );
  assert.equal(webui.notifyKeyEventCalls.length, 0, 'no notifyKeyEvent for dropped 6th-column key');

  // Sanity: a valid wire code does reach sendKeyEvent.
  const validWireCode = wireInputToCora!.findIndex((v) => v >= 0);
  assert.ok(validWireCode >= 0, 'there is at least one valid entry in wireInputToCora');
  fakeDriver.emit('key', { keyIndex: validWireCode, state: 'down' });
  assert.equal(childServer.sendKeyEventCalls.length, 1, 'valid wire code reaches sendKeyEvent');
});

await test('7. constructor wires deps — applyDeviceModel reaches the injected server/childServer/webui', () => {
  const { server, childServer, webui, driverManager } = setup();

  // Default driver mode comes from the constructor (DECKBRIDGE_MOCK env), not a
  // module-level singleton — a fresh instance starts 'real' unless DECKBRIDGE_MOCK=1.
  const expectedMode = tjs.env['DECKBRIDGE_MOCK'] === '1' ? 'mock' : 'real';
  assert.equal(driverManager.getDriverMode(), expectedMode, 'driver mode set from constructor');
  assert.equal(driverManager.getCurrentDriver(), null, 'currentDriver starts null');
  assert.equal(driverManager.getReconnectAttemptCount(), 0, 'reconnectAttemptCount starts at 0');

  driverManager.applyDeviceModel(DEFAULT_MODEL);

  assert.equal(server.setDeviceConfigCalls.length, 1, 'applyDeviceModel reaches injected server');
  assert.equal(
    childServer.setChildGeometryCalls.length,
    1,
    'applyDeviceModel reaches injected childServer',
  );
  assert.equal(webui.notifyDeviceModelCalls.length, 1, 'applyDeviceModel reaches injected webui');
});

await test('8. E1-a: stale-after-probe — switchMode(mock) during a probe discards the found driver', async () => {
  const { webui, driverManager } = setup();
  assert.equal(driverManager.getDriverMode(), 'real', 'driver mode is real by default');

  let created: ControllableRealDriver | null = null;
  driverManager.__setRealDriverFactory((model) => {
    const d = new ControllableRealDriver(model);
    created = d;
    return d as unknown as WorkerHidDriver;
  });

  try {
    // Start a probe but don't await — probeAndOpen() awaits the first
    // factory-created driver's open(), which is pending.
    const probe = driverManager.tryRealConnect();

    // Mode switches away from 'real' while the probe is in flight.
    await driverManager.switchMode('mock');

    // Now let the probed driver's open() resolve.
    created!.resolveOpen();
    await probe;

    assert.equal(created!.closeCalls, 1, 'stale found driver was closed once');
    const current = driverManager.getCurrentDriver();
    assert.ok(current != null, 'a current driver is set (the mock)');
    assert.notEqual(current, created, 'currentDriver is not the stale real driver');

    const staleRealConnect = webui.notifyDriverStatusCalls.find(
      (c) => c.mode === 'real' && c.connected,
    );
    assert.equal(
      staleRealConnect,
      undefined,
      'no {mode:"real", connected:true} notification from the stale probe',
    );
  } finally {
    driverManager.__resetRealDriverFactory();
  }
});

await test('9. E1-b: in-flight guard — a second tryRealConnect() during a probe is a no-op', async () => {
  const { driverManager } = setup();
  assert.equal(driverManager.getDriverMode(), 'real', 'driver mode is real by default');

  let instantiations = 0;
  let firstDriver: ControllableRealDriver | null = null;
  driverManager.__setRealDriverFactory((model) => {
    instantiations++;
    const d = new ControllableRealDriver(model);
    if (!firstDriver) firstDriver = d;
    return d as unknown as WorkerHidDriver;
  });

  try {
    const first = driverManager.tryRealConnect();
    const second = driverManager.tryRealConnect();

    // Let the first probe's driver open() resolve.
    firstDriver!.resolveOpen();

    await first;
    await second;

    assert.ok(
      instantiations <= DEVICE_MODELS.length,
      `probe sweep instantiated drivers for one pass only (got ${instantiations}, max ${DEVICE_MODELS.length})`,
    );
    assert.equal(
      driverManager.getCurrentDriver()?.model,
      firstDriver!.model,
      'real driver connected',
    );
  } finally {
    driverManager.__resetRealDriverFactory();
  }
});

// ── Multi-device coordinator (extra docks) ─────────────────────────────────

/** Fake driver whose open() always succeeds — models a present, openable extra
 *  (or primary) device. Records disconnect wiring via the EventEmitter base. */
class CoordFakeDriver extends EventEmitter {
  readonly model: DeviceModel;
  deviceSerial: string | undefined = 'SN';
  deviceFirmware: string | undefined = '1.0';
  /** Set by open(): the specific unit's path (multi-device), mirroring the real
   *  driver. setupCoord's factory overrides open() to also default the primary's
   *  path from the enumerated list. */
  hidPath: string | undefined = undefined;
  closeCalls = 0;
  brightnessCalls: number[] = [];
  constructor(model: DeviceModel) {
    super();
    this.model = model;
  }
  open(hidPath?: string): Promise<void> {
    this.hidPath = hidPath;
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closeCalls++;
    return Promise.resolve();
  }
  renderCoraImage(): void {}
  sendSplashImage(): void {}
  sendImage(): void {}
  clearKey(): void {}
  setBrightness(level: number): void {
    this.brightnessCalls.push(level);
  }
}

class FactoryServer {
  startCalls = 0;
  stopCalls = 0;
  start(): Promise<void> {
    this.startCalls++;
    return Promise.resolve();
  }
  stop(): Promise<void> {
    this.stopCalls++;
    return Promise.resolve();
  }
  setDeviceConfig(): void {}
  setChildGeometry(): void {}
  restartMdns(): void {}
  pushChildCapabilities(): void {}
  setMdnsServiceName(): void {}
}

class FactoryChildServer extends EventEmitter {
  startCalls = 0;
  stopCalls = 0;
  hasClient = false;
  start(): Promise<void> {
    this.startCalls++;
    return Promise.resolve();
  }
  stop(): Promise<void> {
    this.stopCalls++;
    return Promise.resolve();
  }
  setChildGeometry(): void {}
  sendKeyEvent(): void {}
}

/** Build a coordinator-enabled DriverManager: a session-servers factory (records
 *  identities + servers), a presence set the test can mutate, and a driver
 *  factory that records every driver made (so tests can emit 'disconnect'). */
function setupCoord() {
  const server = makeFakeServer();
  const childServer = makeFakeChildServer();
  const webui = makeFakeWebUI();

  const identities: SessionIdentity[] = [];
  const serversByIndex = new Map<
    number,
    { server: FactoryServer; childServer: FactoryChildServer }
  >();
  const drivers = new Map<string, CoordFakeDriver>();
  const driversByPath = new Map<string, CoordFakeDriver>();
  const present = new Set<string>();
  // Per-model HID paths override; defaults to one synthetic path per present
  // model. Tests wanting same-model duplicates set N paths for one model id.
  const pathsByModel = new Map<string, string[]>();
  const resolvePaths = (m: DeviceModel): string[] =>
    pathsByModel.get(m.id) ?? (present.has(m.id) ? [`hid:${m.id}`] : []);
  let docksChangedCalls = 0;

  const driverManager = new DriverManager({
    webui: webui as unknown as WebUIServer,
    server: server as unknown as ElgatoServer,
    childServer: childServer as unknown as ElgatoChildServer,
    onTrayChange: () => {},
    getShuttingDown: () => false,
    onDocksChanged: () => {
      docksChangedCalls++;
    },
    sessionServersFactory: (identity: SessionIdentity): SessionServers => {
      identities.push(identity);
      const s = new FactoryServer();
      const c = new FactoryChildServer();
      serversByIndex.set(identity.index, { server: s, childServer: c });
      return {
        server: s as unknown as ElgatoServer,
        childServer: c as unknown as ElgatoChildServer,
      };
    },
  });
  driverManager.__setPresenceCheck((m) => present.has(m.id));
  driverManager.__setListModelPaths(resolvePaths);
  driverManager.__setRealDriverFactory((m) => {
    const d = new CoordFakeDriver(m);
    // Mirror the real driver: the primary probe opens with no explicit path and
    // adopts the first enumerated one; an extra is opened at a targeted path.
    d.open = (hidPath?: string) => {
      d.hidPath = hidPath ?? resolvePaths(m)[0];
      if (d.hidPath) driversByPath.set(d.hidPath, d);
      return Promise.resolve();
    };
    drivers.set(m.id, d);
    return d as unknown as WorkerHidDriver;
  });

  return {
    driverManager,
    identities,
    serversByIndex,
    drivers,
    driversByPath,
    present,
    pathsByModel,
    getDocksChangedCalls: () => docksChangedCalls,
  };
}

// Let queued teardown microtasks (onDisconnect → teardownExtraSession → stop) run.
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

await test('C1. one scan after primary connects creates exactly one extra (index 1, ports 5345/5346)', async () => {
  const { driverManager, identities, present } = setupCoord();
  present.add(DEFAULT_MODEL.id); // primary (MK.2)
  present.add(MIRABOX_293_MODEL.id);
  present.add(MIRABOX_293S_MODEL.id);

  await driverManager.tryRealConnect(); // primary claims MK.2
  assert.equal(identities.length, 0, 'no extras before a scan');

  await driverManager.__scanOnce();
  assert.equal(identities.length, 1, 'exactly one extra created per scan tick');
  assert.equal(identities[0]?.index, 1, 'first extra uses index 1');
  assert.equal(identities[0]?.primaryPort, 5345, 'primary port = 5343 + 2*1');
  assert.equal(identities[0]?.childPort, 5346, 'child port = 5344 + 2*1');
});

await test('C2. extras are NOT created while realDriver is null', async () => {
  const { driverManager, identities, present } = setupCoord();
  present.add(DEFAULT_MODEL.id);
  present.add(MIRABOX_293_MODEL.id);

  // No tryRealConnect — primary never connected, realDriver stays null.
  await driverManager.__scanOnce();
  assert.equal(identities.length, 0, 'scan is a no-op until the primary is connected');
});

await test('C3. an extra model going absent does not tear its session down (disconnect-driven)', async () => {
  const { driverManager, identities, serversByIndex, present } = setupCoord();
  present.add(DEFAULT_MODEL.id);
  present.add(MIRABOX_293_MODEL.id);

  await driverManager.tryRealConnect();
  await driverManager.__scanOnce();
  assert.equal(identities.length, 1, 'extra 293 created');

  present.delete(MIRABOX_293_MODEL.id); // device "unplugged" per enumeration
  await driverManager.__scanOnce();
  assert.equal(identities.length, 1, 'no new extra created');
  assert.equal(serversByIndex.get(1)?.server.stopCalls, 0, 'session NOT stopped by absence alone');
});

await test('C4. extra driver disconnect frees its index; a third model reuses index 1', async () => {
  const { driverManager, identities, serversByIndex, drivers, present } = setupCoord();
  present.add(DEFAULT_MODEL.id);
  present.add(MIRABOX_293_MODEL.id);

  await driverManager.tryRealConnect();
  await driverManager.__scanOnce();
  assert.equal(identities[0]?.index, 1, 'extra 293 took index 1');

  // Device disconnects → session teardown frees index 1.
  drivers.get(MIRABOX_293_MODEL.id)!.emit('disconnect');
  await flush();
  assert.equal(serversByIndex.get(1)?.server.stopCalls, 1, 'disconnected session stopped');

  // A different distinct model now appears — it should reuse the freed index 1.
  present.delete(MIRABOX_293_MODEL.id);
  present.add(MIRABOX_K1PRO_MODEL.id);
  await driverManager.__scanOnce();
  assert.equal(identities.length, 2, 'second extra created');
  assert.equal(identities[1]?.index, 1, 'freed index 1 is reused (lowest free wins)');
});

await test("C5. switchMode('mock') tears down all extra sessions", async () => {
  const { driverManager, identities, serversByIndex, present } = setupCoord();
  present.add(DEFAULT_MODEL.id);
  present.add(MIRABOX_293_MODEL.id);

  await driverManager.tryRealConnect();
  await driverManager.__scanOnce();
  assert.equal(identities.length, 1, 'one extra up before switch');

  await driverManager.switchMode('mock');
  assert.equal(serversByIndex.get(1)?.server.stopCalls, 1, 'extra primary server stopped on mock');
  assert.equal(
    serversByIndex.get(1)?.childServer.stopCalls,
    1,
    'extra child server stopped on mock',
  );
});

await test('C6. getDockStatuses(): scanOnce creating an extra returns 2 sorted entries and fires onDocksChanged', async () => {
  const { driverManager, present, getDocksChangedCalls } = setupCoord();
  present.add(DEFAULT_MODEL.id);
  present.add(MIRABOX_293_MODEL.id);

  await driverManager.tryRealConnect();
  const callsAfterConnect = getDocksChangedCalls();
  assert.ok(callsAfterConnect > 0, 'onDocksChanged fired for the primary connect');

  const soloStatuses = driverManager.getDockStatuses();
  assert.equal(soloStatuses.length, 1, 'primary only before any extra is created');
  assert.equal(soloStatuses[0]?.index, 0, 'primary is index 0');
  assert.equal(
    soloStatuses[0]?.modelId,
    DEFAULT_MODEL.id,
    'primary modelId matches connected model',
  );
  assert.equal(
    soloStatuses[0]?.primaryPort,
    ELGATO_TCP_PORT,
    'primary primaryPort is ELGATO_TCP_PORT',
  );
  assert.equal(soloStatuses[0]?.elgatoConnected, false, 'no child client attached yet');

  await driverManager.__scanOnce();
  assert.ok(
    getDocksChangedCalls() > callsAfterConnect,
    'onDocksChanged fired again after the extra dock came up',
  );

  const statuses = driverManager.getDockStatuses();
  assert.equal(statuses.length, 2, 'primary + one extra');
  assert.equal(statuses[0]?.index, 0, 'sorted: primary (index 0) first');
  assert.equal(statuses[1]?.index, 1, 'sorted: extra (index 1) second');
  assert.equal(
    statuses[1]?.modelId,
    MIRABOX_293_MODEL.id,
    'extra modelId matches its device model',
  );
  assert.equal(
    statuses[1]?.primaryPort,
    ELGATO_TCP_PORT + 2,
    'extra primaryPort is strided off ELGATO_TCP_PORT',
  );
});

await test('C7. getDockStatuses(): tearing down the extra drops back to 1 entry and fires onDocksChanged again', async () => {
  const { driverManager, drivers, present, getDocksChangedCalls } = setupCoord();
  present.add(DEFAULT_MODEL.id);
  present.add(MIRABOX_293_MODEL.id);

  await driverManager.tryRealConnect();
  await driverManager.__scanOnce();
  assert.equal(driverManager.getDockStatuses().length, 2, 'primary + extra up');

  const callsBeforeTeardown = getDocksChangedCalls();
  drivers.get(MIRABOX_293_MODEL.id)!.emit('disconnect');
  await flush();

  assert.ok(
    getDocksChangedCalls() > callsBeforeTeardown,
    'onDocksChanged fired again after the extra tore down',
  );
  const statuses = driverManager.getDockStatuses();
  assert.equal(statuses.length, 1, 'back to primary only after the extra disconnects');
  assert.equal(statuses[0]?.index, 0, 'remaining entry is the primary');
});

await test('C8. setDockBrightness routes to the right dock and shows in getDockStatuses', async () => {
  const { driverManager, drivers, present, getDocksChangedCalls } = setupCoord();
  present.add(DEFAULT_MODEL.id);
  present.add(MIRABOX_293_MODEL.id);

  await driverManager.tryRealConnect();
  await driverManager.__scanOnce();

  const before = getDocksChangedCalls();
  driverManager.setDockBrightness(0, 30);
  assert.deepEqual(
    drivers.get(DEFAULT_MODEL.id)!.brightnessCalls,
    [30],
    'primary driver got the level',
  );
  assert.equal(
    drivers.get(MIRABOX_293_MODEL.id)!.brightnessCalls.length,
    0,
    'extra driver untouched by a primary change',
  );
  assert.ok(getDocksChangedCalls() > before, 'primary change fires onDocksChanged');

  driverManager.setDockBrightness(1, 70);
  assert.deepEqual(
    drivers.get(MIRABOX_293_MODEL.id)!.brightnessCalls,
    [70],
    'extra driver got the level',
  );

  const statuses = driverManager.getDockStatuses();
  assert.equal(statuses[0]?.brightness, 30, 'primary status carries its level');
  assert.equal(statuses[1]?.brightness, 70, 'extra status carries its level');
});

await test('D1. two units of the SAME model → primary claims one path, extra opens the other', async () => {
  const { driverManager, identities, drivers, driversByPath, present, pathsByModel } = setupCoord();
  present.add(DEFAULT_MODEL.id); // only one model present…
  pathsByModel.set(DEFAULT_MODEL.id, ['hid:mk2:a', 'hid:mk2:b']); // …but two physical units

  await driverManager.tryRealConnect(); // primary opens the first path (lowest)
  const primary = drivers.get(DEFAULT_MODEL.id);
  assert.equal(primary?.hidPath, 'hid:mk2:a', 'primary adopted the first enumerated path');

  await driverManager.__scanOnce();
  assert.equal(identities.length, 1, 'the second same-model unit opens as one extra');
  assert.equal(identities[0]?.index, 1, 'extra uses index 1');

  const extra = driversByPath.get('hid:mk2:b');
  assert.ok(extra != null, "extra opened the primary's OTHER path, not a re-open of hid:mk2:a");
  assert.notEqual(extra, primary, 'extra is a distinct driver instance from the primary');
  assert.notEqual(
    identities[0]?.deviceKey,
    'hid:mk2:a',
    "extra's deviceKey is not the primary's path",
  );
  assert.equal(identities[0]?.deviceKey, 'hid:mk2:b', "extra's deviceKey is its own path");

  // Idempotent: no third session (both paths now claimed).
  await driverManager.__scanOnce();
  assert.equal(identities.length, 1, 'no further extra — both units claimed');
});

await test('D2. disconnecting one same-model extra tears down only that unit; the other survives', async () => {
  const { driverManager, identities, serversByIndex, driversByPath, present, pathsByModel } =
    setupCoord();
  present.add(DEFAULT_MODEL.id);
  pathsByModel.set(DEFAULT_MODEL.id, ['hid:mk2:a', 'hid:mk2:b', 'hid:mk2:c']); // three units

  await driverManager.tryRealConnect(); // primary claims hid:mk2:a
  await driverManager.__scanOnce(); // extra b → index 1
  await driverManager.__scanOnce(); // extra c → index 2
  assert.equal(identities.length, 2, 'two same-model extras up');
  assert.equal(driverManager.getDockStatuses().length, 3, 'primary + two extras');

  // Unit b disconnects.
  driversByPath.get('hid:mk2:b')!.emit('disconnect');
  await flush();

  assert.equal(serversByIndex.get(1)?.server.stopCalls, 1, 'unit b (index 1) session stopped');
  assert.equal(serversByIndex.get(2)?.server.stopCalls, 0, 'unit c (index 2) session survives');
  assert.equal(driverManager.getDockStatuses().length, 2, 'primary + surviving extra c');

  // The freed path can be re-docked on the next scan (unit b replugged).
  await driverManager.__scanOnce();
  assert.equal(identities.length, 3, 'unit b re-docks into the freed index');
  assert.equal(identities[2]?.index, 1, 'freed index 1 reused');
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
tjs.exit(failed > 0 ? 1 : 0);
