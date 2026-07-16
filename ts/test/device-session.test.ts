import assert from 'tjs:assert';
import { EventEmitter } from '../src/platform/events-shim.js';
import { DeviceSession, sessionIdentity } from '../src/device-session.js';
import type { SessionServers } from '../src/device-session.js';
import { generateDeviceIdentity } from '../src/device-identity.js';
import { DEFAULT_MODEL } from '../src/devices/registry.js';
import { MIRABOX_293S_MODEL } from '../src/devices/mirabox/mirabox-293s.js';
import { deviceInputToMk2Index } from '../src/translator.js';
import {
  ELGATO_TCP_PORT,
  ELGATO_CHILD_PORT,
  CORA_PORT_STRIDE,
  MDNS_SERVICE_NAME,
} from '../src/types.js';
import type { KeyState } from '../src/types.js';
import type { ChildGeometry } from '../src/capabilities.js';
import type { DeviceConfig } from '../src/elgato-types.js';
import type { DeviceModel } from '../src/devices/driver.js';
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

class FakeServer {
  startCalls = 0;
  stopCalls = 0;
  setDeviceConfigCalls: Partial<DeviceConfig>[] = [];
  setChildGeometryCalls: ChildGeometry[] = [];
  restartMdnsCalls: number[] = [];
  pushChildCapabilitiesCalls = 0;
  setMdnsServiceNameCalls: string[] = [];
  start(): Promise<void> {
    this.startCalls++;
    return Promise.resolve();
  }
  stop(): Promise<void> {
    this.stopCalls++;
    return Promise.resolve();
  }
  setDeviceConfig(config: Partial<DeviceConfig>): void {
    this.setDeviceConfigCalls.push(config);
  }
  setChildGeometry(geo: ChildGeometry): void {
    this.setChildGeometryCalls.push(geo);
  }
  restartMdns(productId: number): void {
    this.restartMdnsCalls.push(productId);
  }
  pushChildCapabilities(): void {
    this.pushChildCapabilitiesCalls++;
  }
  setMdnsServiceName(name: string): void {
    this.setMdnsServiceNameCalls.push(name);
  }
}

class FakeChildServer extends EventEmitter {
  startCalls = 0;
  stopCalls = 0;
  setChildGeometryCalls: ChildGeometry[] = [];
  sendKeyEventCalls: { keyIndex: number; state: KeyState }[] = [];
  hasClient = false;
  start(): Promise<void> {
    this.startCalls++;
    return Promise.resolve();
  }
  stop(): Promise<void> {
    this.stopCalls++;
    return Promise.resolve();
  }
  setChildGeometry(geo: ChildGeometry): void {
    this.setChildGeometryCalls.push(geo);
  }
  sendKeyEvent(keyIndex: number, state: KeyState): void {
    this.sendKeyEventCalls.push({ keyIndex, state });
  }
}

class FakeDriver extends EventEmitter {
  readonly model: DeviceModel;
  deviceSerial: string | undefined = 'SN123';
  deviceFirmware: string | undefined = '1.0';
  closeCalls = 0;
  renderCalls: { keyIndex: number; format: string }[] = [];
  splashCalls: number[] = [];
  brightnessCalls: number[] = [];
  constructor(model: DeviceModel) {
    super();
    this.model = model;
  }
  close(): Promise<void> {
    this.closeCalls++;
    return Promise.resolve();
  }
  renderCoraImage(keyIndex: number, _bytes: Uint8Array, format: 'jpeg' | 'bmp'): void {
    this.renderCalls.push({ keyIndex, format });
  }
  sendSplashImage(keyIndex: number): void {
    this.splashCalls.push(keyIndex);
  }
  setBrightness(level: number): void {
    this.brightnessCalls.push(level);
  }
  // start() clears unconfigured extra keys (paintExtraKeys — 293S 6th column).
  clearKeyCalls: number[] = [];
  clearKey(keyIndex: number): void {
    this.clearKeyCalls.push(keyIndex);
  }
}

function testIdentity(model: DeviceModel, deviceKey = 'test-device-key') {
  return generateDeviceIdentity(deviceKey, `${MDNS_SERVICE_NAME} (${model.name})`);
}

function makeSession(model: DeviceModel = DEFAULT_MODEL) {
  const server = new FakeServer();
  const childServer = new FakeChildServer();
  const driver = new FakeDriver(model);
  let disconnects = 0;
  let statusChanges = 0;
  let ignoreElgato = false;
  const imageCalls: { keyIndex: number; format: string }[] = [];
  const session = new DeviceSession({
    identity: sessionIdentity(1, testIdentity(model)),
    servers: { server, childServer } as unknown as SessionServers,
    driver: driver as unknown as WorkerHidDriver,
    model,
    deviceInfo: { serial: driver.deviceSerial, firmware: driver.deviceFirmware },
    onDisconnect: () => {
      disconnects++;
    },
    onStatusChange: () => {
      statusChanges++;
    },
    onImage: (keyIndex, _data, format) => {
      imageCalls.push({ keyIndex, format });
    },
    ignoreElgatoBrightness: () => ignoreElgato,
  });
  return {
    server,
    childServer,
    driver,
    session,
    imageCalls,
    getDisconnects: () => disconnects,
    getStatusChanges: () => statusChanges,
    setIgnoreElgato: (v: boolean) => {
      ignoreElgato = v;
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

await test('sessionIdentity computes ports from index, passes identity fields through unchanged', () => {
  const identity = testIdentity(DEFAULT_MODEL, 'dev-key-A');
  for (const index of [1, 2, 3]) {
    const id = sessionIdentity(index, identity);
    assert.equal(id.index, index, 'index passthrough');
    assert.equal(id.primaryPort, ELGATO_TCP_PORT + CORA_PORT_STRIDE * index, 'primary port stride');
    assert.equal(id.childPort, ELGATO_CHILD_PORT + CORA_PORT_STRIDE * index, 'child port stride');
    // Ports vary with the (scan-order) session index, but identity fields are
    // fixed per physical device — stable across a replug that lands on a
    // different free index (see .claude/plans/2026-07-14_per-device-identity.md).
    assert.equal(id.deviceKey, identity.deviceKey, 'deviceKey passthrough');
    assert.equal(id.mdnsServiceName, identity.mdnsServiceName, 'mdns name passthrough');
    assert.equal(id.dockSerial, identity.dockSerial, 'dock serial passthrough');
    assert.equal(id.childSerial, identity.childSerial, 'child serial passthrough');
    assert.equal(id.macAddress, identity.macAddress, 'mac passthrough');
  }
  // index 1 concretely: 5345 / 5346
  const one = sessionIdentity(1, identity);
  assert.equal(one.primaryPort, 5345, 'index 1 primary = 5345');
  assert.equal(one.childPort, 5346, 'index 1 child = 5346');
});

await test('sessionIdentity: distinct device keys produce distinct 12-char app ids for this pair', () => {
  // The Elgato app keys devices by serial.substring(0, 12) (pairing challenge
  // 0x06) — regression guard that this specific pair of device keys doesn't
  // collide (device-identity.test.ts covers the hash's collision rate broadly).
  const a = sessionIdentity(1, testIdentity(DEFAULT_MODEL, 'dev-key-A'));
  const b = sessionIdentity(1, testIdentity(DEFAULT_MODEL, 'dev-key-B'));
  assert.notEqual(
    a.dockSerial.substring(0, 12),
    b.dockSerial.substring(0, 12),
    'dock serial 12-char prefix distinguishes dev-key-A from dev-key-B',
  );
});

await test('start() applies model to both servers and sends splash', async () => {
  const { server, childServer, driver, session } = makeSession();
  await session.start();

  assert.equal(server.startCalls, 1, 'primary server started');
  assert.equal(childServer.startCalls, 1, 'child server started');
  assert.equal(server.setDeviceConfigCalls.length, 1, 'setDeviceConfig called');
  assert.equal(
    server.setDeviceConfigCalls[0]?.productId,
    DEFAULT_MODEL.cora.productId,
    'PID matches model',
  );
  assert.equal(server.setChildGeometryCalls.length, 1, 'server geometry set');
  assert.equal(childServer.setChildGeometryCalls.length, 1, 'child geometry set');
  assert.equal(server.restartMdnsCalls.length, 1, 'restartMdns called');
  assert.equal(server.pushChildCapabilitiesCalls, 1, 'pushChildCapabilities called');
  assert.ok(driver.splashCalls.length > 0, 'splash images sent to driver');
});

await test('key event translates via keymap and reaches childServer.sendKeyEvent', async () => {
  const { childServer, driver, session } = makeSession(MIRABOX_293S_MODEL);
  await session.start();

  const wireInputToCora = MIRABOX_293S_MODEL.keyMap.wireInputToCora;
  assert.ok(wireInputToCora != null, '293S declares wireInputToCora');
  const validWire = wireInputToCora!.findIndex((v) => v >= 0);
  const expectedMk2 = deviceInputToMk2Index(validWire, MIRABOX_293S_MODEL);

  driver.emit('key', { keyIndex: validWire, state: 'down' });
  assert.equal(childServer.sendKeyEventCalls.length, 1, 'sendKeyEvent called for valid wire code');
  assert.equal(childServer.sendKeyEventCalls[0]?.keyIndex, expectedMk2, 'translated to mk2 index');
  assert.equal(childServer.sendKeyEventCalls[0]?.state, 'down', 'state forwarded');

  // A wire code mapping to -1 is dropped before reaching sendKeyEvent.
  const droppedWire = wireInputToCora!.findIndex((v) => v === -1);
  if (droppedWire >= 0) {
    driver.emit('key', { keyIndex: droppedWire, state: 'down' });
    assert.equal(childServer.sendKeyEventCalls.length, 1, 'dropped key produces no sendKeyEvent');
  }
});

await test('image event reaches driver.renderCoraImage', async () => {
  const { childServer, driver, session } = makeSession();
  await session.start();

  childServer.emit('image', { keyIndex: 4, data: new Uint8Array([1, 2, 3]), format: 'jpeg' });
  assert.equal(driver.renderCalls.length, 1, 'renderCoraImage called once');
  assert.equal(driver.renderCalls[0]?.keyIndex, 4, 'keyIndex forwarded');
  assert.equal(driver.renderCalls[0]?.format, 'jpeg', 'format forwarded');
});

await test('image event mirrors to onImage after the driver render', async () => {
  const { childServer, driver, session, imageCalls } = makeSession();
  await session.start();

  childServer.emit('image', { keyIndex: 7, data: new Uint8Array([5]), format: 'bmp' });
  assert.equal(driver.renderCalls.length, 1, 'driver render still called');
  assert.equal(imageCalls.length, 1, 'onImage mirror fired once');
  assert.equal(imageCalls[0]?.keyIndex, 7, 'keyIndex forwarded to mirror');
  assert.equal(imageCalls[0]?.format, 'bmp', 'format forwarded to mirror');
});

await test('setBrightness applies to the driver and shows in status()', async () => {
  const { driver, session, getStatusChanges } = makeSession();
  await session.start();
  const before = getStatusChanges();

  session.setBrightness(40);
  assert.deepEqual(driver.brightnessCalls, [40], 'driver.setBrightness called');
  assert.equal(session.status().brightness, 40, 'status() reflects the level');
  assert.equal(getStatusChanges(), before + 1, 'status change fired');
});

await test("child 'brightness' applies unless the Elgato override is on", async () => {
  const { childServer, driver, session, setIgnoreElgato } = makeSession();
  await session.start();

  childServer.emit('brightness', 55);
  assert.deepEqual(driver.brightnessCalls, [55], 'Elgato brightness applied');
  assert.equal(session.status().brightness, 55, 'recorded in status');

  setIgnoreElgato(true);
  childServer.emit('brightness', 10);
  assert.deepEqual(driver.brightnessCalls, [55], 'ignored while override on');
  assert.equal(session.status().brightness, 55, 'status unchanged while ignored');
});

await test("driver 'disconnect' fires onDisconnect", async () => {
  const { driver, session, getDisconnects } = makeSession();
  await session.start();
  assert.equal(getDisconnects(), 0, 'no disconnect yet');
  driver.emit('disconnect');
  assert.equal(getDisconnects(), 1, 'onDisconnect fired once');
});

await test('status() reflects identity/model fields and elgatoConnected', async () => {
  const model = MIRABOX_293S_MODEL;
  const { childServer, session } = makeSession(model);
  await session.start();

  childServer.hasClient = false;
  let status = session.status();
  const identity = testIdentity(model);
  assert.equal(status.index, 1, 'index from identity');
  assert.equal(
    status.primaryPort,
    sessionIdentity(1, identity).primaryPort,
    'primaryPort from identity',
  );
  assert.equal(status.modelId, model.id, 'modelId from model');
  assert.equal(status.modelName, model.name, 'modelName from model');
  assert.equal(status.keyCount, model.keyCount, 'keyCount from model');
  assert.equal(status.columns, model.columns, 'columns from model');
  assert.equal(status.rows, model.rows, 'rows from model');
  assert.equal(status.macAddress, identity.macAddress, 'macAddress from identity');
  assert.equal(status.deviceKey, identity.deviceKey, 'deviceKey from identity');
  assert.equal(status.elgatoConnected, false, 'elgatoConnected false when no client');

  childServer.hasClient = true;
  status = session.status();
  assert.equal(status.elgatoConnected, true, 'elgatoConnected true when client attached');
});

await test('onStatusChange fires on start(), stop(), and child client connect/disconnect', async () => {
  const { childServer, session, getStatusChanges } = makeSession();

  await session.start();
  assert.equal(getStatusChanges(), 1, 'fired once after start()');

  childServer.emit('clientConnected');
  assert.equal(getStatusChanges(), 2, 'fired on clientConnected');
  assert.equal(session.status().elgatoConnected, false, 'fake does not auto-flip hasClient');

  childServer.hasClient = true;
  childServer.emit('clientConnected');
  assert.equal(getStatusChanges(), 3, 'fired again on clientConnected');
  assert.equal(session.status().elgatoConnected, true, 'status reflects updated hasClient');

  childServer.emit('clientDisconnected');
  assert.equal(getStatusChanges(), 4, 'fired on clientDisconnected');

  await session.stop();
  assert.equal(getStatusChanges(), 5, 'fired once after stop()');

  await session.stop(); // idempotent — no extra fire
  assert.equal(getStatusChanges(), 5, 'no additional fire on repeated stop()');
});

await test('updateMdnsServiceName renames live, notifies status, and updates status()', async () => {
  const { server, session, getStatusChanges } = makeSession();
  await session.start();
  const before = getStatusChanges();

  session.updateMdnsServiceName('My Renamed Dock');
  assert.deepEqual(server.setMdnsServiceNameCalls, ['My Renamed Dock'], 'server renamed');
  assert.equal(session.status().mdnsServiceName, 'My Renamed Dock', 'status() reflects new name');
  assert.equal(getStatusChanges(), before + 1, 'status change notified');
});

await test('stop() is idempotent and closes driver + both servers', async () => {
  const { server, childServer, driver, session } = makeSession();
  await session.start();

  await session.stop();
  await session.stop(); // idempotent — no double close

  assert.equal(driver.closeCalls, 1, 'driver closed exactly once');
  assert.equal(server.stopCalls, 1, 'primary server stopped exactly once');
  assert.equal(childServer.stopCalls, 1, 'child server stopped exactly once');
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
tjs.exit(failed > 0 ? 1 : 0);
