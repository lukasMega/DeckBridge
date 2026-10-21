import assert from 'tjs:assert';
import { EventEmitter } from '../src/platform/events-shim.js';
import { Dock } from '../src/main/dock.js';
import type { DockSettings } from '../src/main/dock-types.js';
import type { CoraDock } from '../src/main/cora-dock.js';
import { LastFrames, wireDockImages } from '../src/main/dock-frames.js';
import { dockSlot } from '../src/main/dock-status.js';
import { wireVerify } from '../src/main/verify-wiring.js';
import { DEFAULT_TIMING } from '../src/main/standby-policy.js';
import type { ElgatoChildServer } from '../src/cora/child-server.js';
import { DockPrefs, defaultRuntimePrefs } from '../src/infra/dock-prefs.js';
import { generateDeviceIdentity } from '../src/infra/device-identity.js';
import type { DeviceIdentitySettings } from '../src/infra/settings-store.js';
import { PersistedSettings } from '../src/infra/settings.js';
import { findModelById } from '../src/devices/registry.js';
import type { DeviceModel, DeviceModelOverride } from '../src/devices/driver.js';
import type { StandbySettings } from '../src/shared/types.js';
import { VerifyController } from '../src/web/server/verify-controller.js';
import { ModelOverridesController } from '../src/web/server/model-overrides-controller.js';
import type { ControllerHost } from '../src/web/server/types.js';
import type { WebUIServer } from '../src/web/server/index.js';
import { StubDockDriver } from './helpers/stub-dock-driver.js';
import { FakeClock } from './helpers/fake-standby-clock.js';
import { DOCK_IDENTITY } from './helpers/dock-fixture.js';
import { SOLID_RED_16X16_JPEG } from './helpers/fixtures.js';
import { testAsync as test, summaryExit } from './helpers/harness.js';

console.log('\nverify hold: frames, dock, standby, wiring');

const UNTESTED = 'ajazz-akp153r-rev2';
const MODEL: DeviceModel = findModelById(UNTESTED)!;
// CORA key 0 → wire image 11 on the 293V3 board.
const WIRE_OF_KEY_0 = 11;
const MIN = 60_000;
const ROOT = `${tjs.tmpDir}/verify-hold-test-${tjs.pid}`;

class RecordingDriver extends StubDockDriver {
  renders: number[] = [];
  clears: number[] = [];
  splashes = 0;
  override renderCoraImage(key: number): void {
    this.renders.push(key);
  }
  override clearKey(wireId: number): void {
    this.clears.push(wireId);
  }
  override sendSplashImage(): void {
    this.splashes++;
  }
}

const frame = (keyIndex: number) => ({ keyIndex, data: Buffer.from([keyIndex]), format: 'jpeg' });

/** A Dock around a recording driver over a minimal CORA stand-in (no sockets). */
function makeDock(opts: { clock?: FakeClock; standby?: Partial<StandbySettings> } = {}) {
  const child = Object.assign(new EventEmitter(), {
    hasClient: true,
    rxIdleMs: 0,
    sendKeyEvent() {},
    dropClient() {},
  });
  const cora = {
    childServer: child,
    server: { setDeviceConfig() {} },
    hasClient: true,
    childHasClient: true,
    childRxIdleMs: 0,
    applyModel() {},
    setMdnsServiceName() {},
    stop: () => Promise.resolve(),
  } as unknown as CoraDock;
  const identity = generateDeviceIdentity('verify-hold', 'Dock');
  const entry: DeviceIdentitySettings = { ...identity, standby: opts.standby };
  const store = { entryFor: () => entry, persist: () => undefined, runtime: defaultRuntimePrefs() };
  const prefs = new DockPrefs(store, entry.deviceKey);
  const settings = {
    for: () => prefs,
    getOrCreateIdentity: () => entry,
    markPaired: () => false,
  } as unknown as DockSettings;
  let changed = 0;
  const mirrored: number[] = [];
  const dock = new Dock({
    index: 1,
    cora,
    ports: { primary: 5345, child: 5346 },
    settings,
    identity: dockSlot(1, identity),
    model: MODEL,
    hooks: {
      changed: () => {
        changed++;
      },
      image: (key) => void mirrored.push(key),
    },
    standbyClock: opts.clock,
    standbyTiming: opts.clock && { ...DEFAULT_TIMING, silenceMs: 0 },
  });
  const driver = new RecordingDriver(MODEL);
  dock.attach(driver);
  driver.renders.length = 0;
  driver.splashes = 0;
  return { dock, driver, child, mirrored, changed: () => changed };
}

// LastFrames + wireDockImages

await test('held: app frames are recorded, mirrored and counted, but never drawn', () => {
  const child = new EventEmitter();
  const frames = new LastFrames();
  const driver = new RecordingDriver(MODEL);
  frames.replay(driver); // binds the model, as attach does
  const mirrored: number[] = [];
  let appFrames = 0;
  wireDockImages(child as unknown as ElgatoChildServer, {
    driver: () => driver,
    frames,
    onImage: (key) => void mirrored.push(key),
    onAppFrame: () => {
      appFrames++;
    },
  });
  frames.hold();
  child.emit('image', frame(3));
  assert.deepEqual(driver.renders, [], 'no render while held');
  assert.ok(frames.has(3), 'recorded');
  assert.deepEqual(mirrored, [3], 'mirrored to the WebUI');
  assert.equal(appFrames, 1, 'still proof the app is alive');
  frames.repaint(driver);
  frames.replay(driver);
  assert.deepEqual(driver.renders, [], 'repaint and replay are held too');
  frames.release(driver, true, (key) => void mirrored.push(key));
  assert.deepEqual(driver.renders, [3], 'release with repaint draws the recorded frame');
  assert.deepEqual(mirrored, [3, 3]);
  assert.equal(frames.held, false);
});

await test('paintHeld draws only while held; release blanks pattern-only keys', () => {
  const frames = new LastFrames();
  const driver = new RecordingDriver(MODEL);
  frames.paintHeld(driver, 0, SOLID_RED_16X16_JPEG);
  assert.deepEqual(driver.renders, [], 'not held: ignored');
  frames.hold();
  frames.paintHeld(driver, 0, SOLID_RED_16X16_JPEG);
  frames.paintHeld(driver, 1, SOLID_RED_16X16_JPEG);
  frames.record(1, Buffer.from([1]), 'jpeg');
  frames.release(driver, false);
  assert.deepEqual(driver.renders, [0, 1], 'only the pattern; no repaint on the save path');
  assert.deepEqual(driver.clears, [WIRE_OF_KEY_0], 'key 0 had no app frame to come back');
  assert.equal(driver.splashes, 0, 'the app painted, so no splash');
});

await test('release without any app frame brings the splash back', () => {
  const frames = new LastFrames();
  const driver = new RecordingDriver(MODEL);
  frames.hold();
  frames.paintHeld(driver, 0, SOLID_RED_16X16_JPEG);
  frames.release(driver, true);
  assert.ok(driver.splashes > 0);
  assert.deepEqual(driver.clears, [WIRE_OF_KEY_0]);
});

// Dock

await test('Dock hold: live tuning swaps the spec without a repaint; end repaints', () => {
  const h = makeDock();
  h.child.emit('image', frame(2));
  assert.deepEqual(h.driver.renders, [2], 'not held: drawn');
  h.driver.renders.length = 0;
  h.dock.setVerifyHold(true);
  h.child.emit('image', frame(4));
  h.dock.paintVerify(0, SOLID_RED_16X16_JPEG);
  assert.deepEqual(h.driver.renders, [0], 'only the pattern reaches the panel');
  assert.ok(h.mirrored.includes(4), 'the WebUI preview still follows the app');
  h.dock.applyTuning(UNTESTED, () => ({ image: { rotate: 90 } }));
  assert.equal(h.driver.model.image.rotate, 90, 'spec swapped');
  assert.deepEqual(h.driver.renders, [0], 'no frames repaint while held');
  h.dock.setVerifyHold(false, true);
  assert.deepEqual(h.driver.renders, [0, 2, 4], 'end: every recorded frame drawn again');
  assert.deepEqual(h.driver.clears, [WIRE_OF_KEY_0]);
  h.dock.paintVerify(0, SOLID_RED_16X16_JPEG);
  assert.deepEqual(h.driver.renders, [0, 2, 4], 'paintVerify is ignored without a hold');
});

await test('Dock save path: hold off without repaint, the live apply repaints once', () => {
  const h = makeDock();
  h.dock.setVerifyHold(true);
  h.child.emit('image', frame(2));
  h.dock.paintVerify(2, SOLID_RED_16X16_JPEG);
  h.dock.setVerifyHold(false);
  assert.deepEqual(h.driver.renders, [2], 'just the pattern so far');
  assert.deepEqual(h.driver.clears, [], 'key 2 has an app frame');
  h.dock.applyTuning(UNTESTED, () => ({ image: { rotate: 90 } }));
  assert.deepEqual(h.driver.renders, [2, 2], 'the override path repaints');
});

await test('standby: forced awake while held, the dimmed state comes back on release', () => {
  const clock = new FakeClock();
  const h = makeDock({ clock, standby: { idleDim: true, idleMinutes: 5, idleLevel: 10 } });
  clock.advance(5 * MIN + 1000);
  assert.equal(h.dock.status().displayState, 'dimmed');
  h.dock.setVerifyHold(true);
  const held = h.dock.status();
  assert.equal(held.displayState, 'active');
  assert.equal(held.effectiveBrightness, held.brightness, 'no cap while held');
  clock.advance(30 * MIN);
  assert.equal(h.dock.status().displayState, 'active', 'no dim, sleep or clock while held');
  h.dock.setVerifyHold(false, true);
  assert.equal(h.dock.status().displayState, 'dimmed', 'release is not activity');
});

await test('a held dock losing its driver releases the hold and reports the change', () => {
  const h = makeDock();
  h.dock.setVerifyHold(true);
  const before = h.changed();
  h.dock.detach();
  assert.ok(h.changed() > before, 'changed() lets the WebUI end the session');
  const next = new RecordingDriver(MODEL);
  h.dock.attach(next);
  next.renders.length = 0;
  h.child.emit('image', frame(5));
  assert.deepEqual(next.renders, [5], 'a fresh driver is never held');
});

// controller → wiring → dock

let chains = 0;

function chain() {
  const h = makeDock();
  h.child.emit('image', frame(1)); // the app painted key 1
  const settings = new PersistedSettings(`${ROOT}/${++chains}`);
  settings.setModelOverride(UNTESTED, { image: { quality: 0.8 } });
  const bus = new EventEmitter();
  const host: ControllerHost = {
    settings,
    emit: (event, ...args) => bus.emit(event, ...args),
    broadcast: () => {},
    selectedDeviceKey: () => '',
    selectedDock: () => 1,
    selectedDockStatus: () => undefined,
    trySelectDock: () => null,
    broadcastSelected: () => {},
    publishStatus: () => {},
  };
  const status = {
    ...DOCK_IDENTITY,
    index: 1,
    modelId: UNTESTED,
    modelName: MODEL.name,
    keyCount: 15,
    columns: 5,
    rows: 3,
    primaryPort: 5345,
    primaryConnected: true,
    elgatoConnected: true,
    brightness: 100,
  };
  const overrides = new ModelOverridesController(host, () => UNTESTED);
  const verify = new VerifyController(host, overrides, () => [status], new FakeClock());
  // What DriverManager.overrideFor does with its draftOverrideFor dep.
  const overrideFor = (id: string): DeviceModelOverride | undefined =>
    verify.draftOverride(id) ?? settings.overrideFor(id);
  const driverManager = {
    dock: (index: number) => (index === 1 ? h.dock : undefined),
    reloadDeviceTuning: (id: string, kind?: string) => {
      if (kind === 'live') h.dock.applyTuning(id, overrideFor);
      return Promise.resolve();
    },
  };
  wireVerify(
    Object.assign(bus, { verify }) as unknown as Pick<WebUIServer, 'verify' | 'on'>,
    driverManager,
  );
  bus.on('modelOverridesChanged', (id: string, kind: string) => {
    void driverManager.reloadDeviceTuning(id, kind);
  });
  return { h, verify, settings };
}

const JPEG = SOLID_RED_16X16_JPEG.toString('base64');

await test('chain: draft runs live under the hold; cancel restores persisted + frames', () => {
  const { h, verify } = chain();
  const start = verify.start(1);
  assert.ok(!('error' in start));
  if ('error' in start) return;
  assert.equal(start.spec.hasAppFrames, true, 'port answered by the dock');
  h.driver.renders.length = 0;
  assert.equal(verify.paint(start.token, [{ key: 0, data: JPEG }]), null);
  assert.equal(verify.draft(start.token, { rotate: 90 }), null);
  assert.equal(h.driver.model.image.rotate, 90, 'the draft is what the panel runs');
  assert.equal(h.driver.model.image.quality, 0.8, 'over the persisted override');
  assert.deepEqual(h.driver.renders, [0], 'pattern only; the held frames stay off');
  verify.end(start.token);
  assert.equal(h.driver.model.image.rotate, MODEL.image.rotate, 'persisted override back');
  assert.equal(h.driver.model.image.quality, 0.8);
  assert.deepEqual(h.driver.renders, [0, 1], 'and the app frame drawn again');
});

await test('chain: save persists, releases without repaint, the live path repaints once', () => {
  const { h, verify, settings } = chain();
  const start = verify.start(1);
  if ('error' in start) throw new Error(start.error);
  verify.draft(start.token, { rotate: 90 });
  h.driver.renders.length = 0;
  const r = verify.save({ token: start.token, image: { rotate: 90 } });
  assert.deepEqual(r, { ok: true, reconnecting: false });
  assert.deepEqual(settings.overrideFor(UNTESTED), { image: { quality: 0.8, rotate: 90 } });
  assert.equal(h.driver.model.image.rotate, 90);
  assert.deepEqual(h.driver.renders, [1], 'one repaint, from the override path');
});

summaryExit();
