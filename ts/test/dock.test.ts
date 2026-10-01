import assert from 'tjs:assert';
import { EventEmitter } from '../src/platform/events-shim.js';
import {
  dockSlot,
  wireCommonDriverEvents,
  zoneForKnob,
  zoneForTouch,
} from '../src/main/dock-status.js';
import type { DockSlot } from '../src/main/dock-status.js';
import { CoraDock } from '../src/main/cora-dock.js';
import { Dock } from '../src/main/dock.js';
import type { DockHooks, DockSettings } from '../src/main/dock.js';
import type { ElgatoServer } from '../src/cora/primary-server.js';
import type { ElgatoChildServer } from '../src/cora/child-server.js';
import { generateDeviceIdentity } from '../src/infra/device-identity.js';
import { DEFAULT_MODEL } from '../src/devices/registry.js';
import { MIRABOX_293S_MODEL } from '../src/devices/mirabox/mirabox-293s.js';
import { AJAZZ_AKP05E_MODEL } from '../src/devices/ajazz/akp05e.js';
import { applyModelOverrides } from '../src/devices/model-overrides.js';
import { deviceInputToMk2Index } from '../src/shared/key-map.js';
import {
  ELGATO_TCP_PORT,
  ELGATO_CHILD_PORT,
  CORA_PORT_STRIDE,
  MDNS_SERVICE_NAME,
  ELGATO_PLUS_PID,
  DEFAULT_CHILD_FIRMWARE_VERSION,
} from '../src/shared/types.js';
import type {
  DialEvent,
  ExtraKeyConfig,
  KeyState,
  TouchInputEvent,
  TouchStripMode,
} from '../src/shared/types.js';
import type { EncoderOverride } from '../src/main/encoders.js';
import { DockPrefs, defaultRuntimePrefs } from '../src/infra/dock-prefs.js';
import type { DeviceIdentitySettings } from '../src/infra/settings-store.js';
import type { ChildGeometry } from '../src/devices/driver.js';
import type { DeviceConfig } from '../src/cora/types.js';
import type { DeviceModel } from '../src/devices/driver.js';
import type { WorkerHidDriver } from '../src/worker/hid-worker-host.js';
import { testAsync as test, summaryExit } from './helpers/harness.js';
import { StubDockDriver } from './helpers/stub-dock-driver.js';

// Fakes

// Extends EventEmitter so CoraDock's constructor (watchPairing) can attach its
// 'clientDisconnected' listener; these tests never emit on it.
class FakeServer extends EventEmitter {
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
  sendDialCalls: DialEvent[] = [];
  sendDial(event: DialEvent): void {
    this.sendDialCalls.push(event);
  }
  sendTouchCalls: TouchInputEvent[] = [];
  sendTouch(event: TouchInputEvent): void {
    this.sendTouchCalls.push(event);
  }
}

class FakeDriver extends StubDockDriver {
  deviceSerial: string | undefined = 'SN123';
  deviceFirmware: string | undefined = '1.0';
  closeCalls = 0;
  renderCalls: { keyIndex: number; format: string }[] = [];
  splashCalls: number[] = [];
  brightnessCalls: number[] = [];
  override close(): Promise<void> {
    this.closeCalls++;
    return Promise.resolve();
  }
  override renderCoraImage(keyIndex: number, _bytes: Uint8Array, format: 'jpeg' | 'bmp'): void {
    this.renderCalls.push({ keyIndex, format });
  }
  override sendSplashImage(keyIndex: number): void {
    this.splashCalls.push(keyIndex);
  }
  override setBrightness(level: number): void {
    this.brightnessCalls.push(level);
  }
  // start() clears unconfigured extra keys (paintExtraKeys — 293S 6th column).
  clearKeyCalls: number[] = [];
  override clearKey(keyIndex: number): void {
    this.clearKeyCalls.push(keyIndex);
  }
}

/** A real CoraDock (pairing watchdog, applyModel, startWithRetry, stop) over a
 *  fake server pair — exercises the production wiring instead of re-mocking it. */
function makeDock(server: FakeServer, childServer: FakeChildServer): CoraDock {
  return new CoraDock(
    server as unknown as ElgatoServer,
    childServer as unknown as ElgatoChildServer,
    'test dock',
  );
}

function testIdentity(model: DeviceModel, deviceKey = 'test-device-key') {
  return generateDeviceIdentity(deviceKey, `${MDNS_SERVICE_NAME} (${model.name})`);
}

/** Real DockPrefs over one in-memory settings entry. */
function prefsWith(fields: Partial<DeviceIdentitySettings>) {
  const entry: DeviceIdentitySettings = { ...testIdentity(DEFAULT_MODEL), ...fields };
  const store = { entryFor: () => entry, persist: () => undefined, runtime: defaultRuntimePrefs() };
  return { entry, prefs: new DockPrefs(store, entry.deviceKey) };
}

/** An extra-style dock (index from `identity`) over a fake CORA pair and `prefs`. */
function makeTestDock(opts: {
  identity: DockSlot;
  cora: CoraDock;
  model: DeviceModel;
  prefs: DockPrefs;
  deviceInfo?: { serial?: string; firmware?: string };
  hooks?: DockHooks;
}): Dock {
  const settings = {
    for: () => opts.prefs,
    getOrCreateIdentity: () => {
      throw new Error('identity is given up front');
    },
    markPaired: () => false,
  } as unknown as DockSettings;
  return new Dock({
    index: opts.identity.index,
    cora: opts.cora,
    ports: { primary: opts.identity.primaryPort, child: opts.identity.childPort },
    settings,
    identity: opts.identity,
    model: opts.model,
    deviceInfo: opts.deviceInfo,
    hooks: opts.hooks,
  });
}

const encoderFields = (o?: EncoderOverride): Partial<DeviceIdentitySettings> =>
  o ? { touchStripMode: o.mode, encoders: o.encoders } : {};

function makeTestSetup(model: DeviceModel = DEFAULT_MODEL, encoderOverride?: EncoderOverride) {
  const server = new FakeServer();
  const childServer = new FakeChildServer();
  const driver = new FakeDriver(model);
  let disconnects = 0;
  let statusChanges = 0;
  const { entry, prefs } = prefsWith({
    brightnessOverride: false,
    ...encoderFields(encoderOverride),
  });
  const imageCalls: { keyIndex: number; format: string }[] = [];
  const dock = makeTestDock({
    identity: dockSlot(1, testIdentity(model)),
    cora: makeDock(server, childServer),
    model,
    deviceInfo: { serial: driver.deviceSerial, firmware: driver.deviceFirmware },
    hooks: {
      disconnect: () => {
        disconnects++;
      },
      changed: () => {
        statusChanges++;
      },
      image: (keyIndex, _data, format) => {
        imageCalls.push({ keyIndex, format });
      },
    },
    prefs,
  });
  return {
    server,
    childServer,
    driver,
    dock,
    start: () => dock.start(driver),
    imageCalls,
    getDisconnects: () => disconnects,
    getStatusChanges: () => statusChanges,
    setIgnoreElgato: (v: boolean) => {
      entry.brightnessOverride = v;
    },
  };
}

/** An AKP05E re-paired as a Plus whose strip zones carry `configs`, in `mode`. */
function makeStripSetup(
  mode: TouchStripMode,
  configs: Record<number, ExtraKeyConfig>,
  encoderOverride?: EncoderOverride,
) {
  const model = applyModelOverrides(AJAZZ_AKP05E_MODEL, {
    cora: { advertiseAs: 'stream-deck-plus' },
  });
  const server = new FakeServer();
  const childServer = new FakeChildServer();
  const driver = new FakeDriver(model);
  const dock = makeTestDock({
    identity: dockSlot(1, testIdentity(model)),
    cora: makeDock(server, childServer),
    model,
    prefs: prefsWith({
      touchStripMode: mode,
      extraKeys: configs,
      ...encoderFields(encoderOverride),
    }).prefs,
  });
  return {
    dock,
    driver,
    childServer,
    start: () => dock.start(driver),
  };
}

const tap = (x: number): TouchInputEvent => ({ type: 'tap', x, y: 50 });

// Tests

await test('dockSlot computes ports from index, passes identity fields through unchanged', () => {
  const identity = testIdentity(DEFAULT_MODEL, 'dev-key-A');
  for (const index of [1, 2, 3]) {
    const id = dockSlot(index, identity);
    assert.equal(id.index, index, 'index passthrough');
    assert.equal(id.primaryPort, ELGATO_TCP_PORT + CORA_PORT_STRIDE * index, 'primary port stride');
    assert.equal(id.childPort, ELGATO_CHILD_PORT + CORA_PORT_STRIDE * index, 'child port stride');
    // Ports vary with the (scan-order) dock index, but identity fields are
    // fixed per physical device — stable across a replug that lands on a
    // different free index (see .claude/plans/2026-07-14_per-device-identity.md).
    assert.equal(id.deviceKey, identity.deviceKey, 'deviceKey passthrough');
    assert.equal(id.mdnsServiceName, identity.mdnsServiceName, 'mdns name passthrough');
    assert.equal(id.dockSerial, identity.dockSerial, 'dock serial passthrough');
    assert.equal(id.childSerial, identity.childSerial, 'child serial passthrough');
    assert.equal(id.macAddress, identity.macAddress, 'mac passthrough');
  }
  // index 1 concretely: 5345 / 5346
  const one = dockSlot(1, identity);
  assert.equal(one.primaryPort, 5345, 'index 1 primary = 5345');
  assert.equal(one.childPort, 5346, 'index 1 child = 5346');
});

await test('dockSlot: distinct device keys produce distinct 12-char app ids for this pair', () => {
  // The Elgato app keys devices by serial.substring(0, 12) (pairing challenge
  // 0x06) — regression guard that this specific pair of device keys doesn't
  // collide (device-identity.test.ts covers the hash's collision rate broadly).
  const a = dockSlot(1, testIdentity(DEFAULT_MODEL, 'dev-key-A'));
  const b = dockSlot(1, testIdentity(DEFAULT_MODEL, 'dev-key-B'));
  assert.notEqual(
    a.dockSerial.substring(0, 12),
    b.dockSerial.substring(0, 12),
    'dock serial 12-char prefix distinguishes dev-key-A from dev-key-B',
  );
});

await test('start() applies model to both servers and sends splash', async () => {
  const { server, childServer, driver, start } = makeTestSetup();
  await start();

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

await test('Plus emulation forwards a 2.00.x child firmware to the desktop', async () => {
  const rePaired: DeviceModel = {
    ...AJAZZ_AKP05E_MODEL,
    cora: {
      ...AJAZZ_AKP05E_MODEL.cora,
      advertiseAs: 'stream-deck-plus',
      productId: ELGATO_PLUS_PID,
    },
  };
  const { server, start } = makeTestSetup(rePaired);
  await start();
  assert.equal(
    server.setDeviceConfigCalls[0]?.childFirmwareVersion,
    '2.00.026',
    're-paired Plus advertises the Plus firmware line, not the AKP05E default',
  );
});

await test('a native model resets the child firmware to the default (no stale Plus line)', async () => {
  const { server, start } = makeTestSetup(AJAZZ_AKP05E_MODEL);
  await start();
  assert.equal(
    server.setDeviceConfigCalls[0]?.childFirmwareVersion,
    DEFAULT_CHILD_FIRMWARE_VERSION,
  );
});

await test('key event translates via keymap and reaches childServer.sendKeyEvent', async () => {
  const { childServer, driver, start } = makeTestSetup(MIRABOX_293S_MODEL);
  await start();

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

await test('wireCommonDriverEvents reports the raw wire id alongside the mk2 index', () => {
  // Key-map learn mode derives wireInputToCora from these raw codes — the mapped
  // index alone cannot, since a wrong map is exactly what it is there to fix.
  const driver = new EventEmitter() as unknown as WorkerHidDriver;
  const seen: Array<{ mk2Index: number; wireId: number | undefined }> = [];
  wireCommonDriverEvents(driver, MIRABOX_293S_MODEL, {
    onKey: (mk2Index, _state, wireId) => seen.push({ mk2Index, wireId }),
    onReinit: () => undefined,
  });

  const wireInputToCora = MIRABOX_293S_MODEL.keyMap.wireInputToCora;
  assert.ok(wireInputToCora != null, '293S declares wireInputToCora');
  const validWire = wireInputToCora!.findIndex((v) => v >= 0);
  driver.emit('key', { keyIndex: validWire, state: 'down' });

  assert.equal(seen.length, 1, 'one dispatch');
  assert.equal(seen[0]?.wireId, validWire, 'raw wire id passed through untranslated');
  assert.equal(
    seen[0]?.mk2Index,
    deviceInputToMk2Index(validWire, MIRABOX_293S_MODEL),
    'mk2 index still translated',
  );
});

await test('an identity-mapped model reports no wire id', () => {
  // DEFAULT_MODEL (MK.2) has no input keyMap: the wire code IS the mk2 index, so
  // there is nothing for learn mode to derive and the field stays absent.
  const driver = new EventEmitter() as unknown as WorkerHidDriver;
  const seen: Array<number | undefined> = [];
  wireCommonDriverEvents(driver, DEFAULT_MODEL, {
    onKey: (_mk2Index, _state, wireId) => seen.push(wireId),
    onReinit: () => undefined,
  });
  driver.emit('key', { keyIndex: 3, state: 'down' });
  assert.deepEqual(seen, [undefined]);
});

await test('device action observer reports keys, knobs, touch and unknown inputs without consuming them', () => {
  const driver = new EventEmitter() as unknown as WorkerHidDriver;
  const messages: string[] = [];
  let keys = 0;
  let dials = 0;
  let touches = 0;
  wireCommonDriverEvents(
    driver,
    applyModelOverrides(AJAZZ_AKP05E_MODEL, { cora: { advertiseAs: 'stream-deck-plus' } }),
    {
      onAction: (message) => messages.push(message),
      onKey: () => {
        keys++;
      },
      onDial: () => {
        dials++;
      },
      onTouch: () => {
        touches++;
      },
      onReinit: () => undefined,
    },
  );
  driver.emit('key', { keyIndex: 1, state: 'down' });
  driver.emit('key', { keyIndex: 1, state: 'up' });
  driver.emit('dial', { index: 0, kind: 'press', state: 'down' });
  driver.emit('dial', { index: 0, kind: 'rotate', delta: -2 });
  driver.emit('touch', { type: 'tap', x: 100, y: 50 });
  driver.emit('touch', { type: 'swipe', x: 750, y: 50, endX: 50, endY: 50 });
  driver.emit('inputAction', 'Unmapped control 0x40 (state 1)');
  assert.deepEqual(messages, [
    'Key 1 pressed',
    'Key 1 released',
    'Knob 1 pressed',
    'Knob 1 turned left (2)',
    'Knob 1 touch tap (100, 50)',
    'Touch strip swipe (750, 50) → (50, 50)',
    'Unmapped control 0x40 (state 1)',
  ]);
  assert.equal(keys, 2);
  assert.equal(dials, 2);
  assert.equal(touches, 2);
});

await test('dial events reach childServer.sendDial only when the knob override leaves them', async () => {
  const connected = makeTestSetup(AJAZZ_AKP05E_MODEL);
  await connected.start();
  connected.driver.emit('dial', { index: 1, kind: 'rotate', delta: 1 });
  assert.deepEqual(connected.childServer.sendDialCalls, [{ index: 1, kind: 'rotate', delta: 1 }]);

  // Disconnected with no command set: consumed, nothing spawned, nothing forwarded.
  const override: EncoderOverride = {
    mode: 'deckbridge-ignore',
    encoders: { connectToApp: false },
  };
  const disconnected = makeTestSetup(AJAZZ_AKP05E_MODEL, override);
  await disconnected.start();
  disconnected.driver.emit('dial', { index: 1, kind: 'rotate', delta: 1 });
  disconnected.driver.emit('dial', { index: 1, kind: 'press', state: 'down' });
  disconnected.driver.emit('dial', { index: 1, kind: 'press', state: 'up' });
  assert.equal(disconnected.childServer.sendDialCalls.length, 0, 'consumed, not forwarded');
});

await test('status() reports the physical encoder count (AKP05E via its Plus emulation)', () => {
  assert.equal(makeTestSetup(AJAZZ_AKP05E_MODEL).dock.status().encoderCount, 4);
  assert.equal(makeTestSetup(DEFAULT_MODEL).dock.status().encoderCount, undefined, 'omitted');
});

await test('status() reports the re-paired CORA profile only when advertising as one', () => {
  const plus = applyModelOverrides(AJAZZ_AKP05E_MODEL, {
    cora: { advertiseAs: 'stream-deck-plus' },
  });
  assert.equal(makeTestSetup(plus).dock.status().coraProfile, 'stream-deck-plus');
  assert.equal(makeTestSetup(AJAZZ_AKP05E_MODEL).dock.status().coraProfile, undefined, 'native');
});

await test('status() lists the AKP05E right column as pressable extra keys only as a Plus', () => {
  const plus = applyModelOverrides(AJAZZ_AKP05E_MODEL, {
    cora: { advertiseAs: 'stream-deck-plus' },
  });
  const status = makeTestSetup(plus).dock.status();
  assert.deepEqual(status.extraKeys, [15, 10]);
  assert.deepEqual(status.pressableExtraKeys, [15, 10]);
  const native = makeTestSetup(AJAZZ_AKP05E_MODEL).dock.status();
  assert.equal(native.extraKeys, undefined, 'native 5×2 grid has no extra keys');
  assert.equal(native.pressableExtraKeys, undefined);
});

await test('a pressable extra key reaches onExtraKey by its image wire id, not onKey', () => {
  const plus = applyModelOverrides(AJAZZ_AKP05E_MODEL, {
    cora: { advertiseAs: 'stream-deck-plus' },
  });
  const driver = new EventEmitter() as unknown as WorkerHidDriver;
  const keys: number[] = [];
  const extras: Array<[number, string]> = [];
  wireCommonDriverEvents(driver, plus, {
    onKey: (mk2Index) => keys.push(mk2Index),
    onExtraKey: (wireId, state) => extras.push([wireId, state]),
    onReinit: () => undefined,
  });
  driver.emit('key', { keyIndex: 5, state: 'down' }); // top-right
  driver.emit('key', { keyIndex: 10, state: 'up' }); // bottom-right
  driver.emit('key', { keyIndex: 1, state: 'down' }); // Plus key 0
  driver.emit('key', { keyIndex: 0, state: 'down' }); // unmapped
  assert.deepEqual(extras, [
    [15, 'down'],
    [10, 'up'],
  ]);
  assert.deepEqual(keys, [0]);
});

await test('status() carries each strip zone geometry for the WebUI mirror', () => {
  const zones = makeTestSetup(AJAZZ_AKP05E_MODEL).dock.status().widgetDisplays;
  assert.equal(zones?.length, 4);
  assert.deepEqual(zones?.[1], {
    wireId: 2,
    label: 'Left center',
    width: 176,
    height: 112,
    stripX: 204,
    rotate: 180,
    flipH: false,
    flipV: false,
  });
  assert.equal(makeTestSetup(DEFAULT_MODEL).dock.status().widgetDisplays, undefined);
});

await test('a driver stripWrite reaches the stripWrite hook', async () => {
  const model = AJAZZ_AKP05E_MODEL;
  const driver = new FakeDriver(model);
  const writes: Array<[number, Uint8Array, boolean]> = [];
  const dock = makeTestDock({
    identity: dockSlot(1, testIdentity(model)),
    cora: makeDock(new FakeServer(), new FakeChildServer()),
    model,
    hooks: { stripWrite: (wireId, jpeg, full) => writes.push([wireId, jpeg, full]) },
    prefs: prefsWith({}).prefs,
  });
  await dock.start(driver);
  const bytes = new Uint8Array([0xff, 0xd8]);
  driver.emit('stripWrite', 2, bytes, false);
  assert.deepEqual(writes, [[2, bytes, false]]);
});

await test('strip zones map left→right onto taps (800 px Plus strip) and knobs', () => {
  const plus = applyModelOverrides(AJAZZ_AKP05E_MODEL, {
    cora: { advertiseAs: 'stream-deck-plus' },
  });
  assert.deepEqual(
    [0, 199, 200, 450, 799, 900].map((x) => zoneForTouch(plus, tap(x))),
    [1, 1, 2, 3, 4, 4],
  );
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((i) => zoneForKnob(plus, i)),
    [1, 2, 3, 4, undefined],
  );
  assert.equal(zoneForTouch(DEFAULT_MODEL, tap(10)), undefined, 'no strip');
  // Native AKP05E (no Plus profile) advertises no strip, so taps fall back to 800 px.
  assert.deepEqual(
    [0, 199, 200, 450, 799].map((x) => zoneForTouch(AJAZZ_AKP05E_MODEL, tap(x))),
    [1, 1, 2, 3, 4],
  );
});

await test('a tap on a zone showing a widget refreshes it; other gestures and zones reach the app', async () => {
  const { dock, driver, childServer, start } = makeStripSetup('deckbridge-ignore', {
    1: { widget: 'text', param: 'Hi' },
    2: { widget: 'none' },
  });
  await start();
  const before = driver.splashCalls.length;
  driver.emit('touch', tap(100));
  assert.equal(driver.splashCalls.length, before + 1, 'zone 1 flashed');
  assert.equal(driver.splashCalls.at(-1), 1);
  driver.emit('touch', tap(300));
  driver.emit('touch', tap(500));
  driver.emit('touch', { type: 'hold', x: 100, y: 50 });
  driver.emit('touch', { type: 'swipe', x: 100, y: 50, endX: 700, endY: 50 });
  await dock.stop();
  assert.deepEqual(
    childServer.sendTouchCalls.map((e) => `${e.type} ${e.x}`),
    ['tap 300', 'tap 500', 'hold 100', 'swipe 100'],
    "'none' / unassigned zones, hold and swipe are forwarded",
  );
});

await test("taps reach the app under 'elgato' and in a repaint-mode Elgato hold-off", async () => {
  const configs = { 1: { widget: 'text', param: 'Hi' } as ExtraKeyConfig };
  const elgato = makeStripSetup('elgato', configs);
  await elgato.start();
  elgato.driver.emit('touch', tap(100));
  await elgato.dock.stop();
  assert.equal(elgato.childServer.sendTouchCalls.length, 1, "'elgato' strip");

  const repaint = makeStripSetup('deckbridge-repaint', configs);
  await repaint.start();
  repaint.driver.emit('touch', tap(100));
  assert.equal(repaint.childServer.sendTouchCalls.length, 0, 'widget showing → consumed');
  repaint.childServer.emit('touchImage', { data: new Uint8Array(1), region: undefined });
  repaint.driver.emit('touch', tap(100));
  await repaint.dock.stop();
  assert.equal(repaint.childServer.sendTouchCalls.length, 1, "hold-off: the app's image shows");
});

await test('a disconnected knob press with no command refreshes the zone above it', async () => {
  const { dock, driver, childServer, start } = makeStripSetup(
    'deckbridge-ignore',
    { 2: { widget: 'text', param: 'Hi' } },
    { mode: 'deckbridge-ignore', encoders: { connectToApp: false } },
  );
  await start();
  const before = driver.splashCalls.length;
  driver.emit('dial', { index: 1, kind: 'press', state: 'down' });
  driver.emit('dial', { index: 0, kind: 'press', state: 'down' });
  await dock.stop();
  assert.deepEqual(driver.splashCalls.slice(before), [2], 'knob 2 → zone 2; zone 1 has no widget');
  assert.equal(childServer.sendDialCalls.length, 0, 'consumed');
});

await test('image event reaches driver.renderCoraImage', async () => {
  const { childServer, driver, start } = makeTestSetup();
  await start();

  childServer.emit('image', { keyIndex: 4, data: new Uint8Array([1, 2, 3]), format: 'jpeg' });
  assert.equal(driver.renderCalls.length, 1, 'renderCoraImage called once');
  assert.equal(driver.renderCalls[0]?.keyIndex, 4, 'keyIndex forwarded');
  assert.equal(driver.renderCalls[0]?.format, 'jpeg', 'format forwarded');
});

await test('image event mirrors to the image hook after the driver render', async () => {
  const { childServer, driver, imageCalls, start } = makeTestSetup();
  await start();

  childServer.emit('image', { keyIndex: 7, data: new Uint8Array([5]), format: 'bmp' });
  assert.equal(driver.renderCalls.length, 1, 'driver render still called');
  assert.equal(imageCalls.length, 1, 'onImage mirror fired once');
  assert.equal(imageCalls[0]?.keyIndex, 7, 'keyIndex forwarded to mirror');
  assert.equal(imageCalls[0]?.format, 'bmp', 'format forwarded to mirror');
});

await test('setBrightness applies to the driver and shows in status()', async () => {
  const { driver, dock, getStatusChanges, start } = makeTestSetup();
  await start();
  const before = getStatusChanges();

  dock.setBrightness(40);
  assert.deepEqual(driver.brightnessCalls, [40], 'driver.setBrightness called');
  assert.equal(dock.status().brightness, 40, 'status() reflects the level');
  assert.equal(getStatusChanges(), before + 1, 'status change fired');
});

await test('status exposes real device identity separately', () => {
  const { dock } = makeTestSetup();

  assert.deepEqual(dock.status().realDeviceIdentity, {
    modelName: DEFAULT_MODEL.name,
    serialNumber: 'SN123',
    firmwareVersion: '1.0',
  });
});

await test("child 'brightness' applies unless the Elgato override is on", async () => {
  const { childServer, driver, dock, setIgnoreElgato, start } = makeTestSetup();
  await start();

  childServer.emit('brightness', 55);
  assert.deepEqual(driver.brightnessCalls, [55], 'Elgato brightness applied');
  assert.equal(dock.status().brightness, 55, 'recorded in status');

  setIgnoreElgato(true);
  childServer.emit('brightness', 10);
  assert.deepEqual(driver.brightnessCalls, [55], 'ignored while override on');
  assert.equal(dock.status().brightness, 55, 'status unchanged while ignored');
});

await test("driver 'disconnect' fires the disconnect hook", async () => {
  const { driver, getDisconnects, start } = makeTestSetup();
  await start();
  assert.equal(getDisconnects(), 0, 'no disconnect yet');
  driver.emit('disconnect');
  assert.equal(getDisconnects(), 1, 'onDisconnect fired once');
});

await test('status() reflects identity/model fields and elgatoConnected', async () => {
  const model = MIRABOX_293S_MODEL;
  const { childServer, dock, start } = makeTestSetup(model);
  await start();

  childServer.hasClient = false;
  let status = dock.status();
  const identity = testIdentity(model);
  assert.equal(status.index, 1, 'index from identity');
  assert.equal(status.primaryPort, dockSlot(1, identity).primaryPort, 'primaryPort from identity');
  assert.equal(status.modelId, model.id, 'modelId from model');
  assert.equal(status.modelName, model.name, 'modelName from model');
  assert.equal(status.keyCount, model.keyCount, 'keyCount from model');
  assert.equal(status.columns, model.columns, 'columns from model');
  assert.equal(status.rows, model.rows, 'rows from model');
  assert.equal(status.macAddress, identity.macAddress, 'macAddress from identity');
  assert.equal(status.deviceKey, identity.deviceKey, 'deviceKey from identity');
  assert.equal(status.elgatoConnected, false, 'elgatoConnected false when no client');

  childServer.hasClient = true;
  status = dock.status();
  assert.equal(status.elgatoConnected, true, 'elgatoConnected true when client attached');
});

await test('the changed hook fires on start(), stop(), and child client connect/disconnect', async () => {
  const { childServer, dock, getStatusChanges, start } = makeTestSetup();

  await start();
  assert.equal(getStatusChanges(), 1, 'fired once after start()');

  childServer.emit('clientConnected');
  assert.equal(getStatusChanges(), 2, 'fired on clientConnected');
  assert.equal(dock.status().elgatoConnected, false, 'fake does not auto-flip hasClient');

  childServer.hasClient = true;
  childServer.emit('clientConnected');
  assert.equal(getStatusChanges(), 3, 'fired again on clientConnected');
  assert.equal(dock.status().elgatoConnected, true, 'status reflects updated hasClient');

  childServer.emit('clientDisconnected');
  assert.equal(getStatusChanges(), 4, 'fired on clientDisconnected');

  await dock.stop();
  assert.equal(getStatusChanges(), 5, 'fired once after stop()');

  await dock.stop(); // idempotent — no extra fire
  assert.equal(getStatusChanges(), 5, 'no additional fire on repeated stop()');
});

await test('renameMdns renames live, notifies status, and updates status()', async () => {
  const { server, dock, getStatusChanges, start } = makeTestSetup();
  await start();
  const before = getStatusChanges();

  dock.renameMdns('My Renamed Dock');
  assert.deepEqual(server.setMdnsServiceNameCalls, ['My Renamed Dock'], 'server renamed');
  assert.equal(dock.status().mdnsServiceName, 'My Renamed Dock', 'status() reflects new name');
  assert.equal(getStatusChanges(), before + 1, 'status change notified');
});

await test('stop() is idempotent and closes driver + both servers', async () => {
  const { server, childServer, driver, dock, start } = makeTestSetup();
  await start();

  await dock.stop();
  await dock.stop(); // idempotent — no double close

  assert.equal(driver.closeCalls, 1, 'driver closed exactly once');
  assert.equal(server.stopCalls, 1, 'primary server stopped exactly once');
  assert.equal(childServer.stopCalls, 1, 'child server stopped exactly once');
});

await test('stop(): driver close rejects, CORA still closes, stop rejects, changed fires', async () => {
  const { server, childServer, driver, dock, start, getStatusChanges } = makeTestSetup();
  await start();
  driver.close = () => Promise.reject(new Error('no close ack'));
  const before = getStatusChanges();
  let err: unknown;
  await dock.stop().catch((e: unknown) => (err = e));
  assert.ok(err instanceof Error && err.message.includes('no close ack'));
  assert.equal(server.stopCalls, 1);
  assert.equal(childServer.stopCalls, 1);
  assert.equal(getStatusChanges(), before + 1);
});

await test('stop(): driver and CORA both fail, both outcomes are kept', async () => {
  const { server, driver, dock, start } = makeTestSetup();
  await start();
  driver.close = () => Promise.reject(new Error('driver-fail'));
  server.stop = () => Promise.reject(new Error('cora-fail'));
  let err: unknown;
  await dock.stop().catch((e: unknown) => (err = e));
  const text = (err as Error).message;
  assert.ok(text.includes('driver-fail') && text.includes('cora-fail'), text);
});

await test('stop(): a hung driver close does not delay CORA teardown; duplicates share it', async () => {
  const { server, childServer, driver, dock, start } = makeTestSetup();
  await start();
  let release: () => void = () => {};
  driver.close = () => new Promise<void>((r) => (release = r));
  const first = dock.stop();
  const second = dock.stop();
  assert.equal(first, second, 'one shared completion');
  assert.equal(dock.driver, null, 'detached synchronously');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(server.stopCalls, 1, 'CORA closed while the driver close is pending');
  assert.equal(childServer.stopCalls, 1);
  release();
  await first;
});

await test('imagesDrained re-sends splash, replays frames and repaints; not after stop', async () => {
  const { childServer, driver, dock, start } = makeTestSetup();
  await start();
  childServer.emit('image', { keyIndex: 3, data: Buffer.from([1]), format: 'jpeg' });
  const splash = driver.splashCalls.length;
  const renders = driver.renderCalls.length;
  driver.emit('imagesDrained');
  assert.ok(driver.splashCalls.length > splash, 'splash restored');
  assert.equal(driver.renderCalls.length, renders + 1, 'last CORA frame replayed');

  await dock.stop();
  const after = driver.splashCalls.length;
  driver.emit('imagesDrained');
  assert.equal(driver.splashCalls.length, after, 'detached driver: no repaint after stop');
});

await test('imagesDrained is ignored while the app shuts down', async () => {
  const server = new FakeServer();
  const childServer = new FakeChildServer();
  const driver = new FakeDriver(DEFAULT_MODEL);
  const { prefs } = prefsWith({});
  let shuttingDown = false;
  const dock = new Dock({
    index: 1,
    cora: makeDock(server, childServer),
    ports: { primary: 1, child: 2 },
    settings: {
      for: () => prefs,
      getOrCreateIdentity: () => testIdentity(DEFAULT_MODEL),
      markPaired: () => false,
    },
    identity: dockSlot(1, testIdentity(DEFAULT_MODEL)),
    getShuttingDown: () => shuttingDown,
  });
  await dock.start(driver);
  shuttingDown = true;
  const splash = driver.splashCalls.length;
  driver.emit('imagesDrained');
  assert.equal(driver.splashCalls.length, splash);
  await dock.stop();
});

// Summary

summaryExit();
