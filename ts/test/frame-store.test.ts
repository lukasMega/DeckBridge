import assert from 'tjs:assert';
import {
  FRAME_MAX_AGE_MS,
  FrameStore,
  decodeFrames,
  encodeFrames,
} from '../src/infra/frame-store.js';
import type { FrameFs, SavedFrames } from '../src/infra/frame-store.js';
import { testAsync as test, summaryExit } from './helpers/harness.js';

class MemFs implements FrameFs {
  files = new Map<string, Uint8Array>();
  failWrites = false;
  read(path: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.files.get(path) ?? null);
  }
  write(path: string, data: Uint8Array): Promise<void> {
    if (this.failWrites) return Promise.reject(new Error('disk full'));
    this.files.set(path, data);
    return Promise.resolve();
  }
  remove(path: string): Promise<void> {
    this.files.delete(path);
    return Promise.resolve();
  }
  list(dir: string): Promise<string[]> {
    return Promise.resolve(
      [...this.files.keys()]
        .filter((p) => p.startsWith(`${dir}/`))
        .map((p) => p.slice(dir.length + 1)),
    );
  }
}

const DIR = '/cache/last-frames';
const NOW = 10 * FRAME_MAX_AGE_MS;
const sample = (savedAt = NOW): SavedFrames => ({
  modelId: 'mirabox-293',
  savedAt,
  frames: [
    { key: 0, format: 'jpeg', data: new Uint8Array([0xff, 0xd8, 1]) },
    { key: 14, format: 'bmp', data: new Uint8Array([0x42, 0x4d, 2, 3]) },
  ],
});

function make(fs = new MemFs()): { store: FrameStore; fs: MemFs } {
  return { store: new FrameStore(DIR, fs, () => NOW), fs };
}

console.log('\nframe-store: encode/decode');

await test('encode then decode round-trips', () => {
  const out = decodeFrames(encodeFrames('hid:abc/1', sample()))!;
  assert.equal(out.deviceKey, 'hid:abc/1');
  assert.equal(out.modelId, 'mirabox-293');
  assert.equal(out.savedAt, NOW);
  assert.deepEqual(
    out.frames.map((f) => [f.key, f.format, [...f.data]]),
    [
      [0, 'jpeg', [0xff, 0xd8, 1]],
      [14, 'bmp', [0x42, 0x4d, 2, 3]],
    ],
  );
});

await test('a truncated, foreign or wrong-version file decodes to null', () => {
  const good = encodeFrames('k', sample());
  for (let n = 0; n < good.length; n += 3) assert.equal(decodeFrames(good.subarray(0, n)), null);
  assert.equal(decodeFrames(new Uint8Array(40)), null);
  const v2 = Uint8Array.from(good);
  v2[4] = 2;
  assert.equal(decodeFrames(v2), null);
});

console.log('\nframe-store: FrameStore');

await test('save is debounced, written on flush, loaded and taken once', async () => {
  const { store, fs } = make();
  store.save('dev', () => sample());
  assert.equal(fs.files.size, 0, 'not written before the debounce');
  await store.flush();
  assert.equal(fs.files.size, 1);
  const next = make(fs).store;
  await next.load();
  assert.equal(next.take('dev')?.frames.length, 2);
  assert.equal(next.take('dev'), undefined, 'handed out once');
});

await test('a snapshot of null or no frames deletes the file', async () => {
  const { store, fs } = make();
  store.save('dev', () => sample());
  await store.flush();
  store.save('dev', () => null);
  await store.flush();
  assert.equal(fs.files.size, 0);
});

await test('load deletes files that are old, foreign or unreadable', async () => {
  const { store, fs } = make();
  fs.files.set(`${DIR}/old.bin`, encodeFrames('old', sample(NOW - FRAME_MAX_AGE_MS - 1)));
  fs.files.set(`${DIR}/new.bin`, encodeFrames('new', sample(NOW - FRAME_MAX_AGE_MS + 1000)));
  fs.files.set(`${DIR}/junk.bin`, new Uint8Array([1, 2, 3]));
  await store.load();
  assert.deepEqual([...fs.files.keys()], [`${DIR}/new.bin`]);
  assert.equal(store.take('old'), undefined);
  assert.ok(store.take('new'));
});

await test('turning it off deletes the files and saves and hands out nothing', async () => {
  const { store, fs } = make();
  store.save('dev', () => sample());
  await store.flush();
  await store.load();
  await store.setEnabled(false);
  assert.equal(fs.files.size, 0);
  assert.equal(store.take('dev'), undefined);
  store.save('dev', () => sample());
  await store.flush();
  assert.equal(fs.files.size, 0, 'nothing saved while off');
  await store.setEnabled(true);
  store.save('dev', () => sample());
  await store.flush();
  assert.equal(fs.files.size, 1);
});

await test('a write error disables saving instead of throwing', async () => {
  const { store, fs } = make();
  fs.failWrites = true;
  store.save('dev', () => sample());
  await store.flush();
  fs.failWrites = false;
  store.save('dev', () => sample());
  await store.flush();
  assert.equal(fs.files.size, 0, 'self-disabled after the first error');
});

await test('info reports models, counts, sizes and ages, never data', async () => {
  const { store, fs } = make();
  store.save('dev', () => sample(NOW - 5000));
  await store.flush();
  const [info] = await store.info();
  assert.deepEqual(
    Object.keys(info!).toSorted((a, b) => a.localeCompare(b)),
    ['ageMs', 'bytes', 'frames', 'modelId'],
  );
  assert.equal(info!.frames, 2);
  assert.equal(info!.ageMs, 5000);
  assert.equal(info!.bytes, [...fs.files.values()][0]!.length);
});

summaryExit();
