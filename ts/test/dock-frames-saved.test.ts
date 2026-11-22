import assert from 'tjs:assert';
import { LastFrames } from '../src/main/dock-frames.js';
import type { FramesLink } from '../src/main/dock-frames.js';
import type { RenderOptions } from '../src/devices/driver.js';
import type { FrameSaver, SavedFrames } from '../src/infra/frame-store.js';
import { StubDockDriver } from './helpers/stub-dock-driver.js';
import { testAsync as test, summaryExit } from './helpers/harness.js';
import { makePassthroughModel } from './helpers/fixtures.js';

class RecordingDriver extends StubDockDriver {
  rendered: { key: number; stale: boolean }[] = [];
  cleared: number[] = [];
  override renderCoraImage(key: number, _b: Uint8Array, _f: 'jpeg' | 'bmp', opts?: RenderOptions) {
    this.rendered.push({ key, stale: opts?.stale === true });
  }
  override clearKey(key: number): void {
    this.cleared.push(key);
  }
}

class FakeSaver implements FrameSaver {
  saves: (() => SavedFrames | null)[] = [];
  constructor(private readonly saved?: SavedFrames) {}
  take(): SavedFrames | undefined {
    return this.saved;
  }
  save(_key: string, snapshot: () => SavedFrames | null): void {
    this.saves.push(snapshot);
  }
}

const model = makePassthroughModel();
const SAVED_AT = 1_000;
const saved = (): SavedFrames => ({
  modelId: model.id,
  savedAt: SAVED_AT,
  frames: [
    { key: 1, format: 'jpeg', data: new Uint8Array([1]) },
    { key: 2, format: 'bmp', data: new Uint8Array([2]) },
  ],
});

function setup(
  savedFrames?: SavedFrames,
  expiryMs = 20,
): { frames: LastFrames; driver: RecordingDriver; saver: FakeSaver } {
  const driver = new RecordingDriver(model);
  const saver = new FakeSaver(savedFrames);
  const link: FramesLink = {
    driver: () => driver,
    deviceKey: () => 'dev-1',
    saver: () => saver,
    expiryMs,
  };
  return { frames: new LastFrames(link), driver, saver };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const buf = (n: number): Buffer => Buffer.from([n]);

console.log('\ndock-frames: saved frames (stale badge)');

await test('seeded frames replay marked stale', () => {
  const { frames, driver } = setup(saved());
  frames.seedSaved();
  frames.replay(driver);
  assert.deepEqual(driver.rendered, [
    { key: 1, stale: true },
    { key: 2, stale: true },
  ]);
});

await test('a replug of frames from this process replays without the badge', () => {
  const { frames, driver } = setup();
  frames.seedSaved(); // nothing saved
  frames.replay(driver);
  frames.record(3, buf(3), 'jpeg');
  frames.replay(driver);
  assert.deepEqual(driver.rendered, [{ key: 3, stale: false }]);
});

await test('a fresh frame clears the badge for its key only', () => {
  const { frames, driver } = setup(saved());
  frames.seedSaved();
  frames.replay(driver);
  driver.rendered = [];
  frames.record(1, buf(9), 'jpeg');
  frames.repaint(driver);
  assert.deepEqual(driver.rendered, [
    { key: 1, stale: false },
    { key: 2, stale: true },
  ]);
  frames.pause();
});

await test('seeding is ignored once frames exist', () => {
  const { frames } = setup(saved());
  frames.record(5, buf(5), 'jpeg');
  frames.seedSaved();
  frames.expireStale();
  assert.ok(frames.has(5));
  assert.ok(!frames.has(1), 'saved frame 1 was not taken');
});

await test('saved frames of another model are dropped at attach and the file is cleared', () => {
  const other = new RecordingDriver({ ...model, id: 'other-model' });
  const { frames, saver } = setup(saved());
  frames.seedSaved();
  frames.replay(other);
  assert.deepEqual(other.rendered, []);
  assert.ok(!frames.hasAny());
  assert.equal(saver.saves.at(-1)!(), null, 'nothing left to keep');
});

await test('expiry blanks and forgets only the keys still stale', async () => {
  const { frames, driver } = setup(saved(), 20);
  frames.seedSaved();
  frames.replay(driver);
  frames.record(1, buf(9), 'jpeg'); // first fresh frame starts the countdown
  assert.deepEqual(driver.cleared, []);
  await sleep(80);
  assert.deepEqual(driver.cleared, [2]);
  assert.ok(frames.has(1) && !frames.has(2));
});

await test('no expiry fires after pause (detach/stop)', async () => {
  const { frames, driver } = setup(saved(), 20);
  frames.seedSaved();
  frames.replay(driver);
  frames.record(1, buf(9), 'jpeg');
  frames.pause();
  await sleep(80);
  assert.deepEqual(driver.cleared, []);
  assert.ok(frames.has(2));
});

await test('without a fresh frame the stale frames stay (no timer armed)', async () => {
  const { frames, driver } = setup(saved(), 20);
  frames.seedSaved();
  frames.replay(driver);
  await sleep(80);
  assert.deepEqual(driver.cleared, []);
  assert.ok(frames.has(1) && frames.has(2));
});

await test('snapshot keeps the file age for stale frames, a fresh frame moves it', () => {
  const { frames, driver, saver } = setup(saved());
  frames.seedSaved();
  frames.replay(driver);
  frames.record(1, buf(9), 'jpeg');
  const snap = saver.saves.at(-1)!()!;
  assert.ok(snap.savedAt > SAVED_AT, 'a fresh frame is new data');
  assert.deepEqual(
    snap.frames.map((f) => f.key).toSorted((a, b) => a - b),
    [1, 2],
  );
  frames.pause();
  const stale = setup(saved());
  stale.frames.seedSaved();
  stale.frames.replay(stale.driver);
  stale.frames.expireStale();
  assert.equal(
    stale.saver.saves.at(-1)!(),
    null,
    'expiring every stale frame leaves nothing to keep',
  );
});

await test('expireStale (setting off) blanks stale keys at once', () => {
  const { frames, driver } = setup(saved());
  frames.seedSaved();
  frames.replay(driver);
  frames.expireStale();
  assert.deepEqual(
    driver.cleared.toSorted((a, b) => a - b),
    [1, 2],
  );
  assert.ok(!frames.hasAny());
});

summaryExit();
