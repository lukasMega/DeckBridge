import assert from 'tjs:assert';
import { StandbyClockPainter } from '../src/main/standby-clock.js';
import { LastFrames } from '../src/main/dock-frames.js';
import { clockSlotAt, DEFAULT_TIMING } from '../src/main/standby-policy.js';
import { DEFAULT_MODEL } from '../src/devices/registry.js';
import { MIRABOX_293S_MODEL } from '../src/devices/mirabox/mirabox-293s.js';
import { AJAZZ_AKP05E_MODEL } from '../src/devices/ajazz/akp05e.js';
import { applyModelOverrides } from '../src/devices/model-overrides.js';
import { mk2IndexToDeviceImgId } from '../src/shared/key-map.js';
import type { DeviceModel } from '../src/devices/driver.js';
import { StubDockDriver } from './helpers/stub-dock-driver.js';
import { testAsync as test, summaryExit } from './helpers/harness.js';

const MIN = DEFAULT_TIMING.minuteMs;
const T0 = 1000 * MIN;

class RecDriver extends StubDockDriver {
  cleared: number[] = [];
  splash: number[] = [];
  rendered: number[] = [];
  restored: number[][] = [];
  override clearKey(k: number): void {
    this.cleared.push(k);
  }
  override sendSplashImage(k: number): void {
    this.splash.push(k);
  }
  override renderCoraImage(k: number): void {
    this.rendered.push(k);
  }
  override restoreTouchSegments(ids: readonly number[]): void {
    this.restored.push([...ids]);
  }
  reset(): void {
    this.cleared = [];
    this.splash = [];
    this.rendered = [];
  }
}

function setup(model: DeviceModel, zones: number[] = []) {
  const driver = new RecDriver(model);
  const frames = new LastFrames();
  const mirrored: { key: number; format: string }[] = [];
  const painter = new StandbyClockPainter({
    driver: () => driver,
    frames,
    mirror: (key, _d, format) => void mirrored.push({ key, format }),
    appOwnedZones: () => zones,
  });
  return { driver, frames, mirrored, painter };
}

const wires = (model: DeviceModel, keys: number[]): number[] =>
  keys.map((k) => mk2IndexToDeviceImgId(k, model));
const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

await test('MK.2: start clears all 15 keys, paints the pair at the slot, mirrors every key', () => {
  const { driver, mirrored, painter } = setup(DEFAULT_MODEL);
  painter.start(T0);
  assert.deepEqual(
    [...driver.cleared].toSorted((a, b) => a - b),
    range(15),
  );
  const slot = clockSlotAt(T0 / MIN, 5, 15);
  assert.deepEqual(driver.splash, [slot, slot + 1], 'clock then date to its right');
  assert.deepEqual(
    [...new Set(mirrored.map((m) => m.key))].toSorted((a, b) => a - b),
    range(15),
  );
  assert.ok(mirrored.every((m) => m.format === 'bmp'));
});

await test('MK.2: paint at the next minute blanks the old pair and draws the new one', () => {
  const { driver, painter } = setup(DEFAULT_MODEL);
  painter.start(T0);
  const old = [clockSlotAt(T0 / MIN, 5, 15)];
  old.push(old[0]! + 1);
  driver.reset();
  painter.paint(T0 + MIN);
  const slot = clockSlotAt(T0 / MIN + 1, 5, 15);
  const next = [slot, slot + 1];
  assert.deepEqual(driver.splash, next);
  assert.deepEqual(
    [...driver.cleared].toSorted((a, b) => a - b),
    old.filter((k) => !next.includes(k)),
    'only the keys the pair left',
  );
});

await test('paint without a start begins the standby clock', () => {
  const { driver, painter } = setup(DEFAULT_MODEL);
  painter.paint(T0);
  assert.equal(driver.cleared.length, 15);
  assert.equal(driver.splash.length, 2);
});

await test('293S: writes follow coraToWireImage', () => {
  const { driver, painter } = setup(MIRABOX_293S_MODEL);
  painter.start(T0);
  assert.deepEqual(
    [...driver.cleared].toSorted((a, b) => a - b),
    wires(MIRABOX_293S_MODEL, range(15)).toSorted((a, b) => a - b),
  );
  const slot = clockSlotAt(T0 / MIN, 5, 15);
  assert.deepEqual(driver.splash, wires(MIRABOX_293S_MODEL, [slot, slot + 1]));
});

await test('AKP05E as a Plus: 8-key grid, app-owned strip zones blacked then restored', () => {
  const model = applyModelOverrides(AJAZZ_AKP05E_MODEL, {
    cora: { advertiseAs: 'stream-deck-plus' },
  });
  const { driver, painter } = setup(model, [1, 2]);
  painter.start(T0);
  const gridWires = wires(model, range(8));
  for (const w of gridWires) assert.ok(driver.cleared.includes(w), `grid wire ${w} cleared`);
  assert.ok(driver.cleared.includes(1) && driver.cleared.includes(2), 'app zones cleared');
  assert.ok(!driver.cleared.includes(3) && !driver.cleared.includes(4), 'widget zones untouched');
  assert.equal(driver.cleared.length, 10);
  painter.stop();
  assert.deepEqual(driver.restored, [[1, 2]]);
});

await test('stop repaints the last frames with a mirror; clock keys without a frame go black', () => {
  const { driver, frames, mirrored, painter } = setup(DEFAULT_MODEL);
  for (let k = 0; k < 5; k++) frames.record(k, Buffer.from([k]), 'jpeg');
  painter.start(T0);
  const pair = [...driver.splash];
  driver.reset();
  mirrored.length = 0;
  painter.stop();
  assert.deepEqual(driver.rendered, range(5));
  const noFrame = pair.filter((k) => k >= 5);
  assert.deepEqual(
    [...driver.cleared].toSorted((a, b) => a - b),
    noFrame,
  );
  const mirroredKeys = mirrored.map((m) => m.key);
  for (const k of [...range(5), ...noFrame]) assert.ok(mirroredKeys.includes(k), `key ${k}`);
  assert.deepEqual(
    mirrored.filter((m) => m.key < 5).map((m) => m.format),
    Array(5).fill('jpeg'),
  );
});

await test('stop after stop and with no driver does nothing', () => {
  const driver = new RecDriver(DEFAULT_MODEL);
  let attached: RecDriver | null = driver;
  const painter = new StandbyClockPainter({
    driver: () => attached,
    frames: new LastFrames(),
    appOwnedZones: () => [],
  });
  painter.start(T0);
  attached = null;
  painter.stop();
  painter.paint(T0 + MIN);
  assert.equal(driver.restored.length, 0);
});

summaryExit();
