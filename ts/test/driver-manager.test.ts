import assert from 'tjs:assert';
import { EventEmitter } from '../src/platform/events-shim.js';
import { DriverManager } from '../src/driver-manager.js';
import { DEFAULT_MODEL, DEVICE_MODELS } from '../src/devices/registry.js';
import { MIRABOX_293S_MODEL } from '../src/devices/mirabox/mirabox-293s.js';
import type { DeviceModel } from '../src/devices/driver.js';
import type { CommEntry, KeyState } from '../src/types.js';
import type { ChildGeometry } from '../src/capabilities.js';
import type { DeviceConfig } from '../src/elgato-types.js';
import type { ElgatoServer, ElgatoChildServer } from '../src/elgato.js';
import type { WebUIServer } from '../src/web/server/index.js';
import type { WorkerHidDriver } from '../src/hid-worker-host.js';

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
  };
}

function makeFakeChildServer() {
  return {
    setChildGeometryCalls: [] as ChildGeometry[],
    sendKeyEventCalls: [] as { keyIndex: number; state: KeyState }[],
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
    notifyComm(entry: Omit<CommEntry, 'ts'>) {
      this.notifyCommCalls.push(entry);
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

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
tjs.exit(failed > 0 ? 1 : 0);
