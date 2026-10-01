import assert from 'tjs:assert';
import { EventEmitter } from '../src/platform/events-shim.js';
import { DriverManager } from '../src/main/driver-manager.js';
import { ProbePacer, nextProbeDelayMs } from '../src/main/driver-manager-pacing.js';
import { advertisedGeometry, DEFAULT_MODEL, DEVICE_MODELS } from '../src/devices/registry.js';
import { MIRABOX_293_MODEL } from '../src/devices/mirabox/mirabox-293.js';
import { MIRABOX_293S_MODEL } from '../src/devices/mirabox/mirabox-293s.js';
import { MIRABOX_K1PRO_MODEL } from '../src/devices/mirabox/mirabox-k1pro.js';
import { AJAZZ_AKP05E_MODEL } from '../src/devices/ajazz/akp05e.js';
import { MockDriver } from '../src/devices/mock.js';
import type { DockSlot } from '../src/main/dock-status.js';
import { CoraDock } from '../src/main/cora-dock.js';
import type { DeviceModel, DeviceModelOverride } from '../src/devices/driver.js';
import type { CommEntry, DialEvent, KeyState, TouchInputEvent } from '../src/shared/types.js';
import { ELGATO_TCP_PORT, MAX_DOCKS, MAX_MULTI_DECK_DOCKS } from '../src/shared/types.js';
import type { ChildGeometry } from '../src/devices/driver.js';
import type { DeviceConfig } from '../src/cora/types.js';
import type { ElgatoServer } from '../src/cora/primary-server.js';
import type { ElgatoChildServer } from '../src/cora/child-server.js';
import type { WebUIServer } from '../src/web/server/index.js';
import { WorkerHidDriver } from '../src/worker/hid-worker-host.js';
import { WorkerPool } from '../src/main/worker-pool.js';
import type { WorkerFactory } from '../src/main/worker-pool.js';
import type { HidDiscovery } from '../src/main/driver-manager-discovery.js';
import { generateDeviceIdentity } from '../src/infra/device-identity.js';
import type { DeviceIdentitySettings } from '../src/infra/settings-store.js';
import type { PersistedSettings } from '../src/infra/settings.js';
import { DockPrefs, defaultRuntimePrefs } from '../src/infra/dock-prefs.js';
import { testAsync as test, summaryExit } from './helpers/harness.js';
import { StubDockDriver } from './helpers/stub-dock-driver.js';

// Fakes

/** An EventEmitter: CoraDock's pairing watchdog listens on it. */
function makeFakeServer() {
  return Object.assign(new EventEmitter(), {
    hasClient: false,
    stopCalls: 0,
    start(): Promise<void> {
      return Promise.resolve();
    },
    stop(): Promise<void> {
      this.stopCalls++;
      return Promise.resolve();
    },
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
  });
}

/** Dock 0's CORA pair over the fakes — the real CoraDock, as app.ts builds it. */
function primaryCora(
  server: ReturnType<typeof makeFakeServer>,
  childServer: ReturnType<typeof makeFakeChildServer>,
): CoraDock {
  return new CoraDock(
    server as unknown as ElgatoServer,
    childServer as unknown as ElgatoChildServer,
    'dock 0',
  );
}

/** An EventEmitter, so a test can push CORA images/brightness at the primary dock. */
function makeFakeChildServer() {
  return Object.assign(new EventEmitter(), {
    stopCalls: 0,
    start(): Promise<void> {
      return Promise.resolve();
    },
    stop(): Promise<void> {
      this.stopCalls++;
      return Promise.resolve();
    },
    setChildGeometryCalls: [] as ChildGeometry[],
    sendKeyEventCalls: [] as { keyIndex: number; state: KeyState }[],
    hasClient: false,
    setChildGeometry(geo: ChildGeometry) {
      this.setChildGeometryCalls.push(geo);
    },
    sendKeyEvent(keyIndex: number, state: KeyState) {
      this.sendKeyEventCalls.push({ keyIndex, state });
    },
    sendDialCalls: [] as DialEvent[],
    sendDial(event: DialEvent) {
      this.sendDialCalls.push(event);
    },
    sendTouchCalls: [] as TouchInputEvent[],
    sendTouch(event: TouchInputEvent) {
      this.sendTouchCalls.push(event);
    },
  });
}

/** The Elgato app pushing CORA key frames at a dock's child server. */
function pushFrames(childServer: EventEmitter, keys: Array<[number, 'jpeg' | 'bmp']>): void {
  for (const [keyIndex, format] of keys) {
    childServer.emit('image', { keyIndex, data: Buffer.from([keyIndex]), format });
  }
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
    notifyDeviceActionCalls: [] as { dock: number; message: string }[],
    notifyDeviceAction(dock: number, message: string) {
      this.notifyDeviceActionCalls.push({ dock, message });
    },
    notifyElgatoDevicePresentCalls: [] as boolean[],
    notifyElgatoDevicePresent(present: boolean) {
      this.notifyElgatoDevicePresentCalls.push(present);
    },
    notifyComm(entry: Omit<CommEntry, 'ts'>) {
      this.notifyCommCalls.push(entry);
    },
    // Doubles as the PersistedSettings dep (setup() passes it as `settings`).
    devices: [] as DeviceIdentitySettings[],
    runtime: defaultRuntimePrefs(),
    entryFor(deviceKey: string): DeviceIdentitySettings | undefined {
      return this.devices.find((d) => d.deviceKey === deviceKey);
    },
    persist(): void {},
    markPairedCalls: [] as string[],
    // Mirrors PersistedSettings.markPaired's shape closely enough for the
    // extra-dock coordinator's clientConnected handler, which calls it
    // unconditionally on every pairing.
    markPaired(deviceKey: string): boolean {
      this.markPairedCalls.push(deviceKey);
      const entry = this.entryFor(deviceKey);
      if (!entry || entry.pairedAt !== undefined) return false;
      entry.pairedAt = new Date().toISOString();
      return true;
    },
    for(deviceKey: string): DockPrefs {
      return new DockPrefs(this, deviceKey);
    },
    getOrCreateIdentityCalls: [] as { deviceKey: string; defaultMdnsName: string }[],
    // Mirrors PersistedSettings.getOrCreateIdentity: lookup-or-generate + memoize,
    // so tests exercising a reconnect/rescan see a stable identity like production.
    // No persisted brightness override: Elgato-app brightness reaches the device.
    getOrCreateIdentity(deviceKey: string, defaultMdnsName: string): DeviceIdentitySettings {
      this.getOrCreateIdentityCalls.push({ deviceKey, defaultMdnsName });
      const existing = this.entryFor(deviceKey);
      if (existing) return existing;
      const identity = {
        ...generateDeviceIdentity(deviceKey, defaultMdnsName),
        brightnessOverride: false,
      };
      this.devices.push(identity);
      return identity;
    },
    imageChannel: {
      notifyDockTouchImage() {},
      notifyDockWidgetPaint() {},
      notifyDockStripWrite() {},
    },
    notifyBrightnessCalls: [] as number[],
    notifyBrightness(level: number) {
      this.notifyBrightnessCalls.push(level);
    },
    notifyStats() {},
    notifyDockImageCalls: [] as { dock: number; key: number; format: string }[],
    notifyDockImage(dock: number, key: number, _data: unknown, format: 'jpeg' | 'bmp' = 'jpeg') {
      this.notifyDockImageCalls.push({ dock, key, format });
    },
    // Device tuning (settings.json modelOverrides). Defaults to "nothing
    // persisted"; the tuning tests below replace this per instance.
    modelOverrideFor(_modelId: string): DeviceModelOverride | undefined {
      return undefined;
    },
    overrideFor(modelId: string): DeviceModelOverride | undefined {
      return this.modelOverrideFor(modelId);
    },
  };
}

/** A fake "real" driver whose open() rejects while
 * `toggleFailOpen` is true and resolves once it is
 * flipped false. Models a present-but-unopenable device (e.g. */
let toggleFailOpen = true;
class ToggleRealDriver extends StubDockDriver {
  deviceSerial: string | undefined = 'SN123';
  deviceFirmware: string | undefined = '1.0';

  override open(): Promise<void> {
    return toggleFailOpen ? Promise.reject(new Error('no device')) : Promise.resolve();
  }
}

/** A fake "real" driver whose open() resolves only when the test calls
 * `resolveOpen()`, via a `Promise.withResolvers()` deferred. Lets a test pause mid-probe
 * to exercise the post-await state re-check (E1-a) and the in-flight probe guard (E1-b). */
class ControllableRealDriver extends StubDockDriver {
  deviceSerial: string | undefined = 'SN999';
  deviceFirmware: string | undefined = '1.0';
  closeCalls = 0;

  private readonly deferred = Promise.withResolvers<void>();

  override open(): Promise<void> {
    return this.deferred.promise;
  }

  resolveOpen(): void {
    this.deferred.resolve();
  }

  override close(): Promise<void> {
    this.closeCalls++;
    return Promise.resolve();
  }
}

/** A fake "real" driver that records renderCoraImage/sendSplashImage calls, so a
 *  test can assert the deck is repainted from the app's cached frames on replug. */
class RepaintFakeDriver extends StubDockDriver {
  deviceSerial: string | undefined = 'SNIMG';
  deviceFirmware: string | undefined = '1.0';
  hidPath: string | undefined = undefined;
  renderCoraImageCalls: { key: number; format: string }[] = [];
  sendSplashImageCalls = 0;

  override renderCoraImage(key: number, _bytes: unknown, format: 'jpeg' | 'bmp'): void {
    this.renderCoraImageCalls.push({ key, format });
  }
  override sendSplashImage(): void {
    this.sendSplashImageCalls++;
  }
}

/** Injected discovery + worker pool: no FFI, every model present at one fake
 *  path, and a per-test swappable driver factory. The real presence
 *  check (deckbridge-native enumeration) is covered at runtime, not here. */
const realWorker: WorkerFactory = (model, ov) => new WorkerHidDriver(model, ov);

function fakeUsb() {
  const discovery: HidDiscovery = {
    scan: () => Promise.resolve(0),
    present: () => true,
    paths: (model) => [`fake:${model.id}`],
    serial: () => null,
    inventory: () => Promise.resolve({ devices: [], tookMs: 0 }),
    requestReset: () => {},
  };
  const factory = {
    make: realWorker,
    reset(): void {
      this.make = realWorker;
    },
  };
  return { discovery, factory, pool: new WorkerPool((model, ov) => factory.make(model, ov)) };
}

function setup() {
  const usb = fakeUsb();
  const server = makeFakeServer();
  const childServer = makeFakeChildServer();
  const webui = makeFakeWebUI();
  const driverManager = new DriverManager({
    webui: webui as unknown as WebUIServer,
    settings: webui as unknown as PersistedSettings,
    cora: primaryCora(server, childServer),
    getShuttingDown: () => false,
    discovery: usb.discovery,
    pool: usb.pool,
  });
  return { server, childServer, webui, driverManager, usb };
}

// Tests

// NOTE: each test gets its own DriverManager instance via setup(), so
// driverMode always starts at its default ('real' unless DECKBRIDGE_MOCK=1) —
// tryRealConnect() is a no-op unless driverMode === 'real'.
await test('6. getReconnectAttemptCount increments across failed tryRealConnect, resets on success', async () => {
  const { driverManager, usb } = setup();
  assert.equal(
    driverManager.getDriverMode(),
    'real',
    'driver mode is real by default (precondition)',
  );

  toggleFailOpen = true;
  usb.factory.make = (model) => new ToggleRealDriver(model) as unknown as WorkerHidDriver;
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
    usb.factory.reset();
  }
});

await test("6b. one 'changed' event covers connect, Elgato pairing, brightness and unplug", async () => {
  const { childServer, driverManager, usb } = setup();
  const created: RepaintFakeDriver[] = [];
  usb.factory.make = (model) => {
    const d = new RepaintFakeDriver(model);
    created.push(d);
    return d as unknown as WorkerHidDriver;
  };
  let changes = 0;
  driverManager.on('changed', () => changes++);
  try {
    await driverManager.tryRealConnect();
    const afterConnect = changes;
    assert.ok(afterConnect > 0, 'connect');
    childServer.hasClient = true;
    childServer.emit('clientConnected', 'app');
    assert.ok(changes > afterConnect, 'Elgato pairing');
    assert.equal(driverManager.getDockStatuses()[0]?.elgatoConnected, true);
    const afterPair = changes;
    childServer.emit('brightness', 30);
    assert.ok(changes > afterPair, 'brightness from the app');
    const beforeUnplug = changes;
    created[0]!.emit('disconnect');
    assert.ok(changes > beforeUnplug, 'unplug');
    assert.deepEqual(driverManager.getDockStatuses(), [], 'no dock without a driver');
  } finally {
    usb.factory.reset();
  }
});

await test("7. replug repaints the deck from the app's last CORA frames (over the splash)", async () => {
  const { webui, childServer, driverManager, usb } = setup();
  const created: RepaintFakeDriver[] = [];
  usb.factory.make = (model) => {
    const d = new RepaintFakeDriver(model);
    created.push(d);
    return d as unknown as WorkerHidDriver;
  };
  try {
    // First connect: no frames captured yet, so nothing is replayed.
    await driverManager.tryRealConnect();
    const first = created[0]!;
    assert.equal(first.renderCoraImageCalls.length, 0, 'no replay on the first connect');

    // The Elgato app pushed frames for two keys (kept by dock 0).
    pushFrames(childServer, [
      [0, 'jpeg'],
      [3, 'bmp'],
    ]);
    const previewsBefore = webui.notifyDockImageCalls.length;

    // USB unplug: the dock keeps its frames across the WebUI preview wipe.
    first.emit('disconnect');
    assert.equal(driverManager.getCurrentDriver(), null, 'driver cleared on disconnect');

    // USB replug: the same model reconnects.
    await driverManager.tryRealConnect();
    const second = created[1]!;
    assert.ok(second !== first, 'a fresh driver instance after replug');

    // The deck is repainted with the app's last frames (the app never re-pushes).
    assert.equal(second.renderCoraImageCalls.length, 2, 'both cached frames replayed to the deck');
    assert.deepEqual(
      second.renderCoraImageCalls.map((c) => c.key).toSorted((a, b) => a - b),
      [0, 3],
      'the exact cached keys were repainted',
    );
    // The WebUI preview cache is repopulated too.
    assert.equal(
      webui.notifyDockImageCalls.slice(previewsBefore).filter((c) => c.dock === 0).length,
      2,
      'the WebUI preview is restored on replug',
    );
  } finally {
    usb.factory.reset();
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

  // Twice: the mock identity (dock serial + MAC) first, then the model's PID.
  assert.equal(server.setDeviceConfigCalls.length, 2, 'setDeviceConfig: identity, then model');
  assert.equal(
    server.setDeviceConfigCalls[1]?.productId,
    DEFAULT_MODEL.cora.productId,
    'PID matches model',
  );

  // MK.2 advertises its canonical registry geometry.
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

await test('2b. connectMock resolves a per-model mock identity (deviceKey mock:<modelId>)', async () => {
  const { server, webui, driverManager } = setup();

  await driverManager.connectMock(DEFAULT_MODEL);
  assert.equal(webui.getOrCreateIdentityCalls.at(-1)?.deviceKey, `mock:${DEFAULT_MODEL.id}`);
  assert.equal(driverManager.getDockStatuses()[0]?.deviceKey, `mock:${DEFAULT_MODEL.id}`);
  assert.equal(server.setMdnsServiceNameCalls.length, 1, 'identity mDNS name pushed');

  // Switching model is a different mock device, with its own prefs.
  await driverManager.connectMock(AJAZZ_AKP05E_MODEL);
  assert.equal(driverManager.getDockStatuses()[0]?.deviceKey, 'mock:ajazz-akp05e');
  assert.equal(webui.devices.length, 2, 'one persisted identity per mocked model');
});

await test('2c. Mock extraKey/dial/touch reach the primary dock handlers and the app', async () => {
  const { childServer, webui, driverManager } = setup();
  await driverManager.connectMock(AJAZZ_AKP05E_MODEL);
  const driver = driverManager.getCurrentDriver() as MockDriver;

  driver.simulateExtraKey(15);
  assert.equal(webui.notifyDeviceActionCalls.at(-1)?.message, 'Extra key 15 pressed');
  assert.equal(childServer.sendKeyEventCalls.length, 0, 'an extra key never reaches the grid');

  // Knobs default to connectToApp, so the turn is forwarded to the Elgato app.
  driver.simulateDial({ index: 1, kind: 'rotate', delta: -1 });
  assert.deepEqual(childServer.sendDialCalls, [{ index: 1, kind: 'rotate', delta: -1 }]);
  assert.equal(webui.notifyDeviceActionCalls.at(-1)?.message, 'Knob 2 turned left (1)');

  // No widget on the zone → the tap is the app's.
  driver.simulateTouch({ type: 'tap', x: 10, y: 20 });
  assert.deepEqual(childServer.sendTouchCalls, [{ type: 'tap', x: 10, y: 20 }]);
  assert.ok(webui.notifyDeviceActionCalls.at(-1)?.message.includes('tap (10, 20)'));

  // Let the extra key's release timer fire before the next test.
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(webui.notifyDeviceActionCalls.at(-1)?.message, 'Extra key 15 released');
});

await test("3. switchMode('mock') then connectMock() again -> old mock driver closed exactly once", async () => {
  const { driverManager } = setup();

  // switchMode('mock') sets driverMode='mock' and creates the first mock driver. A second
  // switchMode('mock') is a no-op while currentDriver is set (early return in switchMode), so the "replace the
  // active mock driver" path that closes the old driver lives in connectMock() itself — call it directly, as…
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

  const expectedGeo = advertisedGeometry(MIRABOX_293S_MODEL);

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
    'server geometry matches advertised model',
  );
  assert.equal(
    childServer.setChildGeometryCalls.length,
    1,
    'childServer.setChildGeometry called once',
  );
  assert.deepEqual(
    childServer.setChildGeometryCalls[0],
    expectedGeo,
    'childServer geometry matches advertised model',
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
    expectedGeo.keyCount,
    'notified keyCount matches advertised model',
  );
  assert.equal(notified?.columns, expectedGeo.columns, 'notified columns matches advertised model');
  assert.equal(notified?.rows, expectedGeo.rows, 'notified rows matches advertised model');
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

await test('7b. primary: Elgato brightness reaches the driver + WebUI slider unless overridden', async () => {
  const { childServer, webui, driverManager, usb } = setup();
  const created: (RepaintFakeDriver & { brightnessCalls: number[] })[] = [];
  usb.factory.make = (model) => {
    const d = Object.assign(new RepaintFakeDriver(model), { brightnessCalls: [] as number[] });
    d.setBrightness = (level?: number) => {
      d.brightnessCalls.push(level!);
    };
    created.push(d);
    return d as unknown as WorkerHidDriver;
  };
  try {
    await driverManager.tryRealConnect();
    childServer.emit('brightness', 42);
    assert.deepEqual(created[0]?.brightnessCalls, [42], 'applied to the device');
    assert.deepEqual(webui.notifyBrightnessCalls, [42], 'slider follows');
    assert.equal(driverManager.getDockStatuses()[0]?.brightness, 42, 'status carries it');

    const key = driverManager.getDockStatuses()[0]!.deviceKey;
    webui.entryFor(key)!.brightnessOverride = true;
    childServer.emit('brightness', 5);
    assert.deepEqual(created[0]?.brightnessCalls, [42], 'ignored while the override is on');
  } finally {
    usb.factory.reset();
  }
});

await test('7c. primary: Elgato pairing marks the device paired and reports dock 0 attached', async () => {
  const usb = fakeUsb();
  const server = makeFakeServer();
  const childServer = makeFakeChildServer();
  const webui = makeFakeWebUI();
  const attached: number[] = [];
  const driverManager = new DriverManager({
    webui: webui as unknown as WebUIServer,
    settings: webui as unknown as PersistedSettings,
    cora: primaryCora(server, childServer),
    getShuttingDown: () => false,
    onElgatoAttached: (index) => attached.push(index),
    discovery: usb.discovery,
    pool: usb.pool,
  });
  await driverManager.connectMock(DEFAULT_MODEL);
  childServer.emit('clientConnected', 'app');
  assert.deepEqual(webui.markPairedCalls, [`mock:${DEFAULT_MODEL.id}`]);
  assert.deepEqual(attached, [0]);
});

await test('8. E1-a: stale-after-probe — switchMode(mock) during a probe discards the found driver', async () => {
  const { webui, driverManager, usb } = setup();
  assert.equal(driverManager.getDriverMode(), 'real', 'driver mode is real by default');

  let created: ControllableRealDriver | null = null;
  usb.factory.make = (model) => {
    const d = new ControllableRealDriver(model);
    created = d;
    return d as unknown as WorkerHidDriver;
  };

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
    usb.factory.reset();
  }
});

await test('9. E1-b: in-flight guard — a second tryRealConnect() during a probe is a no-op', async () => {
  const { driverManager, usb } = setup();
  assert.equal(driverManager.getDriverMode(), 'real', 'driver mode is real by default');

  let instantiations = 0;
  let firstDriver: ControllableRealDriver | null = null;
  usb.factory.make = (model) => {
    instantiations++;
    const d = new ControllableRealDriver(model);
    if (!firstDriver) firstDriver = d;
    return d as unknown as WorkerHidDriver;
  };

  try {
    const first = driverManager.tryRealConnect();
    const second = driverManager.tryRealConnect();

    // Discovery is asynchronous, even with the test seam. Let it reach open().
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(firstDriver, 'first probe reached driver open');
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
    usb.factory.reset();
  }
});

// Multi-device coordinator (scanned docks)

/** Fake driver whose open() always succeeds — models a present, openable extra
 *  (or primary) device. Records disconnect wiring via the EventEmitter base. */
class CoordFakeDriver extends StubDockDriver {
  deviceSerial: string | undefined = 'SN';
  deviceFirmware: string | undefined = '1.0';
  /** Set by open(): the specific unit's path, mirroring the real driver. */
  hidPath: string | undefined = undefined;
  closeCalls = 0;
  brightnessCalls: number[] = [];
  renderCalls: number[] = [];
  applyOverridesCalls: (DeviceModelOverride | undefined)[] = [];
  override applyOverrides(
    overrides: DeviceModelOverride | undefined,
    effectiveModel: DeviceModel,
  ): void {
    this.applyOverridesCalls.push(overrides);
    this.model = effectiveModel;
  }
  override open(hidPath: string): Promise<void> {
    this.hidPath = hidPath;
    return Promise.resolve();
  }
  override close(): Promise<void> {
    this.closeCalls++;
    return Promise.resolve();
  }
  override renderCoraImage(keyIndex: number): void {
    this.renderCalls.push(keyIndex);
  }
  override setBrightness(level: number): void {
    this.brightnessCalls.push(level);
  }
}

// Extends EventEmitter so CoraDock's constructor (watchPairing) can attach its
// 'clientDisconnected' listener; these tests never emit on it.
class FactoryServer extends EventEmitter {
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

/** Build a scan-enabled DriverManager: a CoraDock factory (records
 *  identities + servers), a presence set the test can mutate, and a driver
 *  factory that records every driver made (so tests can emit 'disconnect'). */
function setupCoord(maxDocks: number = MAX_MULTI_DECK_DOCKS) {
  const usb = fakeUsb();
  const server = makeFakeServer();
  const childServer = makeFakeChildServer();
  const webui = makeFakeWebUI();

  const identities: DockSlot[] = [];
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
    settings: webui as unknown as PersistedSettings,
    cora: primaryCora(server, childServer),
    getShuttingDown: () => false,
    discovery: usb.discovery,
    pool: usb.pool,
    coraDockFactory: (identity: DockSlot): CoraDock => {
      identities.push(identity);
      const s = new FactoryServer();
      const c = new FactoryChildServer();
      serversByIndex.set(identity.index, { server: s, childServer: c });
      return new CoraDock(
        s as unknown as ElgatoServer,
        c as unknown as ElgatoChildServer,
        `test dock ${identity.index}`,
      );
    },
  });
  driverManager.on('changed', () => {
    docksChangedCalls++;
  });
  usb.discovery.present = (m) => present.has(m.id);
  usb.discovery.paths = resolvePaths;
  // Multi-deck is opt-in and off by default; these tests exercise the enabled
  // path. Raising the cap takes effect synchronously (only LOWERING it awaits a
  // dock teardown), so the returned promise needs no await here.
  void driverManager.setMultiDeck(maxDocks > 1, maxDocks);
  usb.factory.make = (m) => {
    const d = new CoordFakeDriver(m);
    d.open = (hidPath: string) => {
      d.hidPath = hidPath;
      driversByPath.set(hidPath, d);
      return Promise.resolve();
    };
    drivers.set(m.id, d);
    return d as unknown as WorkerHidDriver;
  };

  return {
    driverManager,
    usb,
    identities,
    serversByIndex,
    drivers,
    driversByPath,
    present,
    pathsByModel,
    webui,
    getDocksChangedCalls: () => docksChangedCalls,
  };
}

// Let queued teardown microtasks (onDisconnect → teardownDock → stop) run.
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

await test('C3. an extra model going absent does not tear its dock down (disconnect-driven)', async () => {
  const { driverManager, identities, serversByIndex, present } = setupCoord();
  present.add(DEFAULT_MODEL.id);
  present.add(MIRABOX_293_MODEL.id);

  await driverManager.tryRealConnect();
  await driverManager.__scanOnce();
  assert.equal(identities.length, 1, 'extra 293 created');

  present.delete(MIRABOX_293_MODEL.id); // device "unplugged" per enumeration
  await driverManager.__scanOnce();
  assert.equal(identities.length, 1, 'no new extra created');
  assert.equal(serversByIndex.get(1)?.server.stopCalls, 0, 'dock NOT stopped by absence alone');
});

await test('C4. extra driver disconnect frees its index; a third model reuses index 1', async () => {
  const { driverManager, identities, serversByIndex, drivers, present } = setupCoord();
  present.add(DEFAULT_MODEL.id);
  present.add(MIRABOX_293_MODEL.id);

  await driverManager.tryRealConnect();
  await driverManager.__scanOnce();
  assert.equal(identities[0]?.index, 1, 'extra 293 took index 1');

  // Device disconnects → dock teardown frees index 1.
  drivers.get(MIRABOX_293_MODEL.id)!.emit('disconnect');
  await flush();
  assert.equal(serversByIndex.get(1)?.server.stopCalls, 1, 'disconnected dock stopped');

  // A different distinct model now appears — it should reuse the freed index 1.
  present.delete(MIRABOX_293_MODEL.id);
  present.add(MIRABOX_K1PRO_MODEL.id);
  await driverManager.__scanOnce();
  assert.equal(identities.length, 2, 'second extra created');
  assert.equal(identities[1]?.index, 1, 'freed index 1 is reused (lowest free wins)');
});

await test("C5. switchMode('mock') tears down all scanned docks", async () => {
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
  assert.deepEqual(soloStatuses[0]?.realDeviceIdentity, {
    modelName: DEFAULT_MODEL.name,
    serialNumber: 'SN',
    firmwareVersion: '1.0',
  });

  await driverManager.__scanOnce();
  assert.ok(
    getDocksChangedCalls() > callsAfterConnect,
    'onDocksChanged fired again after the scanned dock came up',
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

await test('C8. dock(i).setBrightness routes to the right dock and shows in getDockStatuses', async () => {
  const { driverManager, drivers, present, getDocksChangedCalls } = setupCoord();
  present.add(DEFAULT_MODEL.id);
  present.add(MIRABOX_293_MODEL.id);

  await driverManager.tryRealConnect();
  await driverManager.__scanOnce();

  const before = getDocksChangedCalls();
  driverManager.dock(0)?.setBrightness(30);
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

  driverManager.dock(1)?.setBrightness(70);
  assert.deepEqual(
    drivers.get(MIRABOX_293_MODEL.id)!.brightnessCalls,
    [70],
    'extra driver got the level',
  );

  const statuses = driverManager.getDockStatuses();
  assert.equal(statuses[0]?.brightness, 30, 'primary status carries its level');
  assert.equal(statuses[1]?.brightness, 70, 'extra status carries its level');
});

await test('C8b. dockForDevice finds the dock serving a device key (mDNS rename)', async () => {
  const { driverManager, identities, serversByIndex, present, getDocksChangedCalls } = setupCoord();
  present.add(DEFAULT_MODEL.id);
  present.add(MIRABOX_293_MODEL.id);
  await driverManager.tryRealConnect();
  await driverManager.__scanOnce();

  const extraKey = identities[0]!.deviceKey;
  assert.equal(driverManager.dockForDevice(extraKey)?.index, 1, 'the extra, by its key');
  assert.equal(driverManager.dockForDevice('nope'), undefined, 'unknown key: no dock');

  const before = getDocksChangedCalls();
  const renamed: string[] = [];
  serversByIndex.get(1)!.server.setMdnsServiceName = (name?: string) => {
    renamed.push(name!);
  };
  driverManager.dockForDevice(extraKey)?.renameMdns('Desk B');
  assert.deepEqual(renamed, ['Desk B'], 'the extra re-advertises');
  assert.equal(driverManager.getDockStatuses()[1]?.mdnsServiceName, 'Desk B');
  assert.ok(getDocksChangedCalls() > before, 'status change notified');
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

  // Idempotent: no third dock (both paths now claimed).
  await driverManager.__scanOnce();
  assert.equal(identities.length, 1, 'no further extra — both units claimed');
});

await test('D2. disconnecting one same-model extra tears down only that unit; the other survives', async () => {
  // Three docks: above the multi-deck opt-in's cap of 2, so the index pool is
  // opened to the structural ceiling for this one test.
  const { driverManager, identities, serversByIndex, driversByPath, present, pathsByModel } =
    setupCoord(MAX_DOCKS);
  present.add(DEFAULT_MODEL.id);
  pathsByModel.set(DEFAULT_MODEL.id, ['hid:mk2:a', 'hid:mk2:b', 'hid:mk2:c']);

  await driverManager.tryRealConnect(); // primary claims hid:mk2:a
  await driverManager.__scanOnce(); // extra b → index 1
  await driverManager.__scanOnce(); // extra c → index 2
  assert.equal(identities.length, 2, 'two same-model extras up');
  assert.equal(driverManager.getDockStatuses().length, 3, 'primary + two extras');

  // Unit b disconnects.
  driversByPath.get('hid:mk2:b')!.emit('disconnect');
  await flush();

  assert.equal(serversByIndex.get(1)?.server.stopCalls, 1, 'unit b (index 1) dock stopped');
  assert.equal(serversByIndex.get(2)?.server.stopCalls, 0, 'unit c (index 2) dock survives');
  assert.equal(driverManager.getDockStatuses().length, 2, 'primary + surviving extra c');

  // The freed path can be re-docked on the next scan (unit b replugged).
  await driverManager.__scanOnce();
  assert.equal(identities.length, 3, 'unit b re-docks into the freed index');
  assert.equal(identities[2]?.index, 1, 'freed index 1 reused');
});

await test('C9. live tuning reaches a scanned dock without tearing its session down', async () => {
  const { driverManager, driversByPath, present, serversByIndex } = setupCoord();
  present.add(DEFAULT_MODEL.id);
  present.add(MIRABOX_293_MODEL.id);
  await driverManager.tryRealConnect();
  await driverManager.__scanOnce();
  const extra = driversByPath.get(`hid:${MIRABOX_293_MODEL.id}`);
  assert.ok(extra !== undefined, 'precondition: the second device docked');

  await driverManager.reloadDeviceTuning(MIRABOX_293_MODEL.id, 'live');

  assert.equal(extra!.applyOverridesCalls.length, 1, 'the scanned dock swapped its spec');
  assert.equal(extra!.closeCalls, 0, 'and was never closed');
  assert.equal(serversByIndex.get(1)?.server.stopCalls, 0, 'its CORA servers stayed up');
  assert.equal(driverManager.getDockStatuses().length, 2, 'both docks still present');
});

await test('C10. scanned dock re-pushes the persisted brightness ~1s after Elgato pairing (B8)', async () => {
  const { driverManager, identities, drivers, serversByIndex, present, webui } = setupCoord();
  present.add(DEFAULT_MODEL.id);
  present.add(MIRABOX_293_MODEL.id);

  await driverManager.tryRealConnect();
  await driverManager.__scanOnce();
  const entry = webui.devices.find((d) => d.deviceKey === identities[0]?.deviceKey);
  assert.ok(entry, 'precondition: scanned dock has a persisted identity entry');
  entry!.brightness = 66; // simulate a previously-saved preference

  const extraDriver = drivers.get(MIRABOX_293_MODEL.id)!;
  const callsBeforeConnect = extraDriver.brightnessCalls.length;
  serversByIndex.get(1)!.childServer.emit('clientConnected');
  assert.equal(
    extraDriver.brightnessCalls.length,
    callsBeforeConnect,
    'no immediate resend on connect',
  );

  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(
    extraDriver.brightnessCalls.at(-1),
    66,
    'persisted brightness re-pushed once pairing settles',
  );
});

await test('C11. tearing a scanned dock down clears its pending brightness resend', async () => {
  const { driverManager, identities, drivers, serversByIndex, present, webui } = setupCoord();
  present.add(DEFAULT_MODEL.id);
  present.add(MIRABOX_293_MODEL.id);

  await driverManager.tryRealConnect();
  await driverManager.__scanOnce();
  const entry = webui.devices.find((d) => d.deviceKey === identities[0]?.deviceKey);
  entry!.brightness = 66;

  const extraDriver = drivers.get(MIRABOX_293_MODEL.id)!;
  serversByIndex.get(1)!.childServer.emit('clientConnected');
  drivers.get(MIRABOX_293_MODEL.id)!.emit('disconnect'); // torn down before the resend fires
  await flush();

  await new Promise((r) => setTimeout(r, 1100));
  assert.notEqual(
    extraDriver.brightnessCalls.at(-1),
    66,
    'timer cleared by teardown — no resend against the closed driver',
  );
});

// Multi-deck opt-in (settings.json `multiDeck`) — single deck is the default.

await test('M1. multi-deck OFF (default): a second device is never docked', async () => {
  const { driverManager, identities, present } = setupCoord(1);
  present.add(DEFAULT_MODEL.id);
  present.add(MIRABOX_293_MODEL.id);

  await driverManager.tryRealConnect();
  await driverManager.__scanOnce();

  assert.equal(identities.length, 0, 'no scanned dock while multi-deck is off');
  assert.equal(driverManager.getDockStatuses().length, 1, 'primary only');
});

await test('M2. multi-deck OFF: startScan() installs no timer, so nothing enumerates', async () => {
  const { driverManager, present, usb } = setupCoord(1);
  present.add(DEFAULT_MODEL.id);
  present.add(MIRABOX_293_MODEL.id);
  await driverManager.tryRealConnect();

  let enumerations = 0;
  usb.discovery.paths = (m) => {
    enumerations++;
    return present.has(m.id) ? [`hid:${m.id}`] : [];
  };

  driverManager.startScan();
  await new Promise<void>((r) => setTimeout(r, 30));
  driverManager.stopScan();
  assert.equal(enumerations, 0, 'the extras scan never ran with multi-deck off');
});

await test('M3. setMultiDeck(true) allows exactly ONE extra; a third unit is refused', async () => {
  const { driverManager, identities, present, pathsByModel } = setupCoord(1);
  present.add(DEFAULT_MODEL.id);
  pathsByModel.set(DEFAULT_MODEL.id, ['hid:mk2:a', 'hid:mk2:b', 'hid:mk2:c']);

  await driverManager.tryRealConnect(); // primary claims hid:mk2:a
  await driverManager.setMultiDeck(true);

  await driverManager.__scanOnce();
  assert.equal(identities.length, 1, 'second unit docks');
  await driverManager.__scanOnce();
  assert.equal(identities.length, 1, 'third unit refused — cap is 2 docks total');
  assert.equal(driverManager.getDockStatuses().length, 2, 'primary + one extra');
});

await test('M4. setMultiDeck(false) tears a live scanned dock down', async () => {
  const { driverManager, identities, serversByIndex, present } = setupCoord();
  present.add(DEFAULT_MODEL.id);
  present.add(MIRABOX_293_MODEL.id);

  await driverManager.tryRealConnect();
  await driverManager.__scanOnce();
  assert.equal(identities.length, 1, 'extra up before the toggle');

  await driverManager.setMultiDeck(false);
  assert.equal(serversByIndex.get(1)?.server.stopCalls, 1, 'extra primary server stopped');
  assert.equal(serversByIndex.get(1)?.childServer.stopCalls, 1, 'extra child server stopped');
  assert.equal(driverManager.getDockStatuses().length, 1, 'back to the primary alone');

  // And it stays down: no re-dock on a later tick.
  await driverManager.__scanOnce();
  assert.equal(identities.length, 1, 'no new extra created while multi-deck is off');
});

// Device tuning (settings.json modelOverrides — see devices/model-overrides.ts)

/** A driver whose open() always succeeds, capturing the model + override the
 *  manager handed the factory. Stands in for WorkerHidDriver, which would
 *  forward the same pair to the worker in its 'open' message. */
class CapturingDriver extends StubDockDriver {
  readonly overrides: DeviceModelOverride | undefined;
  deviceSerial: string | undefined = 'SN-TUNED';
  deviceFirmware: string | undefined = '1.0';
  hidPath: string | undefined = undefined;
  constructor(model: DeviceModel, overrides?: DeviceModelOverride) {
    super(model);
    this.overrides = overrides;
  }
  override renderCoraImage(keyIndex: number): void {
    this.renderCalls.push(keyIndex);
  }
  renderCalls: number[] = [];
  applyOverridesCalls: { overrides: DeviceModelOverride | undefined; modelId: string }[] = [];
  override applyOverrides(
    overrides: DeviceModelOverride | undefined,
    effectiveModel: DeviceModel,
  ): void {
    this.applyOverridesCalls.push({ overrides, modelId: effectiveModel.id });
    this.model = effectiveModel;
  }
}

await test('E1. probe hands the worker the EFFECTIVE model plus the raw override', async () => {
  const { webui, driverManager, usb } = setup();
  const firstModel = DEVICE_MODELS[0]!;
  const override: DeviceModelOverride = { image: { rotate: 180 }, keyMap: { inputOffset: 4 } };
  webui.modelOverrideFor = (modelId: string) => (modelId === firstModel.id ? override : undefined);

  const created: CapturingDriver[] = [];
  usb.factory.make = (model, ov) => {
    created.push(new CapturingDriver(model, ov));
    return created[0] as unknown as WorkerHidDriver;
  };
  usb.discovery.present = (m) => m.id === firstModel.id;

  await driverManager.tryRealConnect();

  const driver = created[0];
  assert.ok(driver !== undefined, 'a driver was created');
  assert.equal(driver!.model.image.rotate, 180, 'the driver sees the tuned rotation');
  assert.equal(driver!.model.keyMap.inputOffset, 4, 'and the tuned input mapping');
  // The raw override travels alongside: the worker re-derives the effective model
  // from ITS OWN registry copy, so no override can select a different driver.
  assert.deepEqual(driver!.overrides, override, 'raw override forwarded to the worker');
  assert.equal(driver!.model.protocol, firstModel.protocol, 'protocol is registry-sourced');
  assert.equal(driver!.model.usbVendorId, firstModel.usbVendorId, 'VID is registry-sourced');
});

await test('E2. the tuned geometry/identity reaches the CORA servers and the WebUI', async () => {
  const { webui, driverManager, usb } = setup();
  const firstModel = DEVICE_MODELS[0]!;
  webui.modelOverrideFor = () => ({ image: { rotate: 90 } });
  usb.factory.make = (model, ov) => new CapturingDriver(model, ov) as unknown as WorkerHidDriver;
  usb.discovery.present = (m) => m.id === firstModel.id;

  await driverManager.tryRealConnect();
  const notified = webui.notifyDeviceModelCalls.at(-1);
  assert.equal(notified?.id, firstModel.id, 'the model id is unchanged by tuning');
  assert.equal(
    driverManager.getCurrentDriver()?.model.image.rotate,
    90,
    'the session-visible model carries the tuning',
  );
});

await test('E3. the registry model is never mutated by an override', async () => {
  const { webui, driverManager, usb } = setup();
  const firstModel = DEVICE_MODELS[0]!;
  const before = JSON.stringify(firstModel);
  webui.modelOverrideFor = () => ({ image: { rotate: 270, quality: 0.1 } });
  usb.factory.make = (model, ov) => new CapturingDriver(model, ov) as unknown as WorkerHidDriver;
  usb.discovery.present = (m) => m.id === firstModel.id;

  await driverManager.tryRealConnect();
  assert.equal(JSON.stringify(firstModel), before, 'the registry stays ground truth');
});

await test('E4. no override → the registry model reaches the driver unchanged', async () => {
  const { webui, driverManager, usb } = setup();
  const firstModel = DEVICE_MODELS[0]!;
  webui.modelOverrideFor = () => undefined;
  const created: CapturingDriver[] = [];
  usb.factory.make = (model, ov) => {
    created.push(new CapturingDriver(model, ov));
    return created[0] as unknown as WorkerHidDriver;
  };
  usb.discovery.present = (m) => m.id === firstModel.id;

  await driverManager.tryRealConnect();
  assert.ok(created[0]?.model === firstModel, 'same object, not a copy');
  assert.equal(created[0]?.overrides, undefined, 'nothing forwarded to the worker');
});

/** Connect a CapturingDriver for the first registry model and return it. */
async function connectCapturing({
  driverManager,
  usb,
}: ReturnType<typeof setup>): Promise<CapturingDriver> {
  const firstModel = DEVICE_MODELS[0]!;
  const created: CapturingDriver[] = [];
  usb.factory.make = (model, ov) => {
    const d = new CapturingDriver(model, ov);
    created.push(d);
    return d as unknown as WorkerHidDriver;
  };
  usb.discovery.present = (m) => m.id === firstModel.id;
  await driverManager.tryRealConnect();
  return created[0]!;
}

await test('E5. an image-only tuning change is applied live — no close, no reconnect', async () => {
  const env = setup();
  const { webui, childServer, driverManager } = env;
  const firstModel = DEVICE_MODELS[0]!;
  const driver = await connectCapturing(env);
  // Two frames the Elgato app already pushed: the live swap must repaint them,
  // or the panel keeps images encoded under the old spec.
  pushFrames(childServer, [
    [0, 'jpeg'],
    [3, 'jpeg'],
  ]);
  driver.renderCalls.length = 0;
  webui.modelOverrideFor = () => ({ image: { rotate: 90 } });

  await driverManager.reloadDeviceTuning(firstModel.id, 'live');

  assert.equal(driverManager.getCurrentDriver(), driver, 'the session stayed up');
  assert.equal(driver.applyOverridesCalls.length, 1, 'the spec was swapped on the driver');
  assert.deepEqual(driver.applyOverridesCalls[0]?.overrides, { image: { rotate: 90 } });
  assert.equal(driverManager.getCurrentDriver()?.model.image.rotate, 90, 'tuned spec is visible');
  assert.deepEqual(driver.renderCalls, [0, 3], 'both cached frames were re-rendered');
});

await test('E6. a wire/keyMap change still closes the session and reconnects', async () => {
  const env = setup();
  const { driverManager } = env;
  const firstModel = DEVICE_MODELS[0]!;
  const driver = await connectCapturing(env);

  await driverManager.reloadDeviceTuning(firstModel.id, 'reopen');

  assert.equal(driverManager.getCurrentDriver(), null, 'the session was torn down');
  assert.equal(driver.applyOverridesCalls.length, 0, 'no live swap on a reopen change');
});

await test('E7. an unchanged override touches neither the driver nor the session', async () => {
  const env = setup();
  const { driverManager } = env;
  const firstModel = DEVICE_MODELS[0]!;
  const driver = await connectCapturing(env);

  await driverManager.reloadDeviceTuning(firstModel.id, 'none');

  assert.equal(driverManager.getCurrentDriver(), driver, 'the session stayed up');
  assert.equal(driver.applyOverridesCalls.length, 0, 'nothing pushed to the worker');
  assert.deepEqual(driver.renderCalls, [], 'and nothing repainted');
});

await test('E8. mock mode: a cleared override reopens on the registry model, not the tuned one', async () => {
  const { driverManager, webui } = setup();
  await driverManager.switchMode('mock');
  await driverManager.connectMock(MIRABOX_293_MODEL);

  webui.modelOverrideFor = () => ({ image: { rotate: 270 } });
  await driverManager.reloadDeviceTuning(MIRABOX_293_MODEL.id, 'reopen');
  assert.equal(driverManager.getCurrentDriver()?.model.image.rotate, 270, 'override in force');

  webui.modelOverrideFor = () => undefined;
  await driverManager.reloadDeviceTuning(MIRABOX_293_MODEL.id, 'reopen');
  assert.equal(
    driverManager.getCurrentDriver()?.model.image.rotate,
    MIRABOX_293_MODEL.image.rotate,
    'reset really dropped the override',
  );
  assert.equal(driverManager.getCurrentDriver()?.model.id, MIRABOX_293_MODEL.id, 'same model');
});

// F. Probe pacing under slow HID enumeration (issue #67.2)

await test('F1. a fast enumeration keeps the 3s probe interval', () => {
  assert.equal(nextProbeDelayMs(3_000, 5), 3_000, 'healthy sweep → baseline');
  assert.equal(nextProbeDelayMs(3_000, 249), 3_000, 'just under the slow threshold');
});

await test('F2. a slow enumeration backs the probe interval off, capped at 30s', () => {
  let delay = 3_000;
  delay = nextProbeDelayMs(delay, 900);
  assert.equal(delay, 6_000, 'first slow sweep doubles');
  delay = nextProbeDelayMs(delay, 900);
  assert.equal(delay, 12_000, 'and again');
  for (let i = 0; i < 10; i++) delay = nextProbeDelayMs(delay, 900);
  assert.equal(delay, 30_000, 'capped — a deck plugged in later still connects');
});

await test('F3. recovery snaps straight back to the baseline', () => {
  assert.equal(nextProbeDelayMs(30_000, 3), 3_000, 'keyboard unplugged → 3s again');
});

await test('F4. the manager starts at the baseline interval', () => {
  const { driverManager } = setup();
  assert.equal(driverManager.__reconnectDelayMs(), 3_000, 'no backoff before any sweep');
});

await test('F5. the cold first sweep never triggers a backoff', () => {
  const pacer = new ProbePacer();
  // dlopen + a cold OS HID stack costs ~700ms on a healthy machine; only the
  // sweeps after it describe the steady state.
  pacer.note(900);
  assert.equal(pacer.delayMs, 3_000, 'first sweep is discarded');
  pacer.note(900);
  assert.equal(pacer.delayMs, 6_000, 'the second one counts');
});

await test('F6. the pacer keeps one reconnect pending and counts attempts until a connect', async () => {
  const pacer = new ProbePacer();
  pacer.delayMs = 0;
  let runs = 0;
  pacer.schedule(() => runs++);
  pacer.schedule(() => runs++); // already pending
  assert.equal(pacer.attempts, 1, 'one attempt scheduled');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(runs, 1, 'and it ran once');

  pacer.started(); // the probe it ran
  pacer.schedule(() => runs++);
  assert.equal(pacer.attempts, 2, 'a failed probe schedules the next');
  pacer.connected();
  assert.equal(pacer.attempts, 0, 'reset on connect');
  await new Promise((r) => setTimeout(r, 5));
});

// Application shutdown (P1 plan, Stage 5 / F12 + F13)

await test('S1. shutdown stops the primary dock: driver closed, CORA pair stopped, idempotent', async () => {
  const { driverManager, server, childServer, usb } = setup();
  let created: ControllableRealDriver | null = null;
  usb.factory.make = (model) => {
    created = new ControllableRealDriver(model);
    created.resolveOpen();
    return created as unknown as WorkerHidDriver;
  };
  try {
    await driverManager.tryRealConnect();
    assert.ok(driverManager.getCurrentDriver(), 'precondition: connected');
    const a = driverManager.shutdown();
    assert.equal(driverManager.shutdown(), a, 'one shared shutdown');
    await a;
    assert.equal(created!.closeCalls, 1, 'primary driver closed through Dock.stop()');
    assert.equal(driverManager.getCurrentDriver(), null);
    assert.equal(server.stopCalls, 1);
    assert.equal(childServer.stopCalls, 1);
  } finally {
    usb.factory.reset();
  }
});

await test('S2. a probe that opens after shutdown is closed, never attached', async () => {
  const usb = fakeUsb();
  const webui = makeFakeWebUI();
  let shutting = false;
  const driverManager = new DriverManager({
    webui: webui as unknown as WebUIServer,
    settings: webui as unknown as PersistedSettings,
    cora: primaryCora(makeFakeServer(), makeFakeChildServer()),
    getShuttingDown: () => shutting,
    discovery: usb.discovery,
    pool: usb.pool,
  });
  let created: ControllableRealDriver | null = null;
  usb.factory.make = (model) => {
    created ??= new ControllableRealDriver(model);
    return created as unknown as WorkerHidDriver;
  };
  const probe = driverManager.tryRealConnect();
  await flush();
  shutting = true;
  const stopping = driverManager.shutdown();
  created!.resolveOpen();
  await probe;
  await stopping;
  assert.equal(created!.closeCalls, 1, 'late driver closed');
  assert.equal(driverManager.getCurrentDriver(), null, 'never attached');
  assert.ok(
    !webui.notifyDriverStatusCalls.some((c) => c.mode === 'real' && c.connected),
    'never reported connected',
  );
});

await test('S3. a scanned dock still opening at shutdown is closed and never registered (F13)', async () => {
  const { driverManager, identities, present, usb, driversByPath } = setupCoord();
  present.add(DEFAULT_MODEL.id);
  present.add(MIRABOX_293_MODEL.id);
  await driverManager.tryRealConnect();
  const pending = Promise.withResolvers<void>();
  let extra: CoordFakeDriver | null = null;
  usb.factory.make = (m) => {
    const d = new CoordFakeDriver(m);
    d.open = (hidPath: string) => {
      d.hidPath = hidPath;
      driversByPath.set(hidPath, d);
      return pending.promise;
    };
    extra = d;
    return d as unknown as WorkerHidDriver;
  };
  const scan = driverManager.__scanOnce();
  await flush();
  assert.ok(extra, 'precondition: the extra open is in flight');
  const stopping = driverManager.shutdown();
  pending.resolve();
  await scan;
  await stopping;
  assert.equal(extra!.closeCalls, 1, 'the late-opening extra was closed');
  assert.equal(identities.length, 0, 'no scanned dock was ever created');
  assert.deepEqual(driverManager.getDockStatuses(), []);
});

await test('S4. shutdown cancels the pending reconnect timer', async () => {
  const pacer = new ProbePacer();
  let probes = 0;
  pacer.delayMs = 10;
  pacer.schedule(() => probes++);
  pacer.cancel();
  pacer.schedule(() => probes++);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(probes, 0);
});

await test('S5. a stalled secondary open does not hold the primary dock open (R4)', async () => {
  const { driverManager, present, usb, driversByPath } = setupCoord();
  present.add(DEFAULT_MODEL.id);
  present.add(MIRABOX_293_MODEL.id);
  await driverManager.tryRealConnect();
  const primary = driverManager.getCurrentDriver() as unknown as CoordFakeDriver;
  const pending = Promise.withResolvers<void>();
  let extra: CoordFakeDriver | null = null;
  usb.factory.make = (m) => {
    const d = new CoordFakeDriver(m);
    d.open = (hidPath: string) => {
      d.hidPath = hidPath;
      driversByPath.set(hidPath, d);
      return pending.promise;
    };
    extra = d;
    return d as unknown as WorkerHidDriver;
  };
  const scan = driverManager.__scanOnce();
  await flush();
  assert.ok(extra, 'precondition: the extra open is in flight');
  let done = false;
  const stopping = driverManager.shutdown().then(() => (done = true));
  await flush();
  assert.equal(primary.closeCalls, 1, 'primary closed while the secondary open is pending');
  assert.equal(done, false, 'shutdown still waits for the pending creation');
  pending.resolve();
  await scan;
  await stopping;
  assert.equal(extra!.closeCalls, 1, 'late driver closed');
});

await test('S6. a primary driver that never acks close fails shutdown; parked workers still close', async () => {
  const { driverManager, present, usb } = setupCoord();
  present.add(DEFAULT_MODEL.id);
  await driverManager.tryRealConnect();
  const primary = driverManager.getCurrentDriver() as unknown as CoordFakeDriver;
  primary.close = () => Promise.reject(new Error('no close ack'));
  const parked = new CoordFakeDriver(MIRABOX_293_MODEL);
  usb.pool.park(MIRABOX_293_MODEL.id, parked as unknown as WorkerHidDriver);
  let err: unknown;
  await driverManager.shutdown().catch((e: unknown) => (err = e));
  assert.ok(err instanceof Error && err.message.includes('no close ack'));
  assert.equal(parked.closeCalls, 1, 'parked worker still closed');
});

// Summary

summaryExit();
