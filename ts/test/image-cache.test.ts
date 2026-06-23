import assert from 'tjs:assert';
import { hashJpeg, makeCacheKey, imageCache } from '../src/image-cache.js';
import { IMAGE_CACHE_SIZE } from '../src/types.js';

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

// ── hashJpeg ─────────────────────────────────────────────────────────────────

console.log('\nhashJpeg');

test('deterministic: same buffer → same hash', () => {
  const buf = new Uint8Array(570);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 31 + 17) & 0xff;
  const h1 = hashJpeg(buf);
  const h2 = hashJpeg(buf);
  assert.equal(h1, h2);
});

test('distinct: different buffers → different hashes', () => {
  const a = new Uint8Array(570);
  const b = new Uint8Array(570);
  for (let i = 0; i < a.length; i++) {
    a[i] = (i * 31 + 17) & 0xff;
    b[i] = (i * 13 + 7) & 0xff;
  }
  assert.notEqual(hashJpeg(a), hashJpeg(b));
});

test('output format: 8-char lowercase hex string', () => {
  const buf = new Uint8Array([0xff, 0x00, 0xab, 0xcd]);
  const h = hashJpeg(buf);
  assert.equal(typeof h, 'string');
  assert.equal(h.length, 8);
  assert.ok(/^[0-9a-f]{8}$/.test(h), `expected 8 hex chars, got: ${h}`);
});

test('zero buffer hashes to padded 8-char string', () => {
  const buf = new Uint8Array(4);
  const h = hashJpeg(buf);
  assert.equal(h.length, 8);
  assert.ok(/^[0-9a-f]{8}$/.test(h));
});

// ── full-buffer hashing (large buffers, e.g. 19 KB gen1 BMP) ─────────────────

console.log('\nhashJpeg — large buffers');

const SAMPLE_SIZE = 20 * 1024;

function makeBuf(size: number, seed = 1): Uint8Array {
  const buf = new Uint8Array(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 31 + seed) & 0xff;
  return buf;
}

test('large buffer: same buffer → same hash', () => {
  const buf = makeBuf(SAMPLE_SIZE);
  assert.equal(hashJpeg(buf), hashJpeg(buf));
});

test('large buffer: differing first bytes → different hash', () => {
  const a = makeBuf(SAMPLE_SIZE);
  const b = makeBuf(SAMPLE_SIZE);
  b[0] = (b[0]! ^ 0xff) & 0xff;
  assert.notEqual(hashJpeg(a), hashJpeg(b));
});

test('large buffer: differing last bytes → different hash', () => {
  const a = makeBuf(SAMPLE_SIZE);
  const b = makeBuf(SAMPLE_SIZE);
  b[b.length - 1] = (b[b.length - 1]! ^ 0xff) & 0xff;
  assert.notEqual(hashJpeg(a), hashJpeg(b));
});

// Regression: a small centred icon on a black background differs from a blank
// black frame only in the MIDDLE bytes. The old first/last-4 KB sampling hashed
// them identically, so the cached black transform was served for the icon and
// the key showed up black. Full-buffer hashing must distinguish them.
test('large buffer: differing middle bytes → different hash (icon-on-black regression)', () => {
  const blank = new Uint8Array(SAMPLE_SIZE); // all-zero "black frame"
  const icon = new Uint8Array(SAMPLE_SIZE); // same length, content in the middle only
  const mid = SAMPLE_SIZE >> 1;
  for (let i = mid - 64; i < mid + 64; i++) icon[i] = 0xff;
  assert.notEqual(hashJpeg(blank), hashJpeg(icon));
});

test('large buffer: differing length (same prefix) → different hash', () => {
  const a = makeBuf(SAMPLE_SIZE);
  const b = makeBuf(SAMPLE_SIZE + 16);
  assert.notEqual(hashJpeg(a), hashJpeg(b));
});

// ── makeCacheKey ──────────────────────────────────────────────────────────────

console.log('\nmakeCacheKey');

test('same inputs → same key', () => {
  const k1 = makeCacheKey('mirabox-293', 'aabbccdd');
  const k2 = makeCacheKey('mirabox-293', 'aabbccdd');
  assert.equal(k1, k2);
});

test('different modelId → different key (same jpegHash)', () => {
  const hash = 'aabbccdd';
  const k1 = makeCacheKey('mirabox-293', hash);
  const k2 = makeCacheKey('elgato/mk2', hash);
  assert.notEqual(k1, k2);
});

test('different jpegHash → different key (same modelId)', () => {
  const k1 = makeCacheKey('mirabox-293', 'aabbccdd');
  const k2 = makeCacheKey('mirabox-293', '11223344');
  assert.notEqual(k1, k2);
});

test('default mode arg → "def" (preserves old 2-arg callers)', () => {
  assert.equal(makeCacheKey('mirabox-293s', 'aabbccdd'), 'mirabox-293s:def:aabbccdd');
  assert.equal(
    makeCacheKey('mirabox-293s', 'aabbccdd'),
    makeCacheKey('mirabox-293s', 'aabbccdd', 'def'),
  );
});

test('different mode → different key (same modelId/jpegHash)', () => {
  const k1 = makeCacheKey('mirabox-293s', 'aabbccdd', 'resize');
  const k2 = makeCacheKey('mirabox-293s', 'aabbccdd', 'pad-edge');
  const k3 = makeCacheKey('mirabox-293s', 'aabbccdd');
  assert.notEqual(k1, k2);
  assert.notEqual(k1, k3);
  assert.notEqual(k2, k3);
});

// ── LruCache via imageCache (IMAGE_CACHE_SIZE = 100) ─────────────────────────
//
// imageCache is a shared singleton; we use a unique key prefix ("__tc__")
// so our test entries don't collide with any previous state. We insert
// IMAGE_CACHE_SIZE + 1 fresh entries and verify that the oldest is evicted
// while the newest remain.

console.log('\nLruCache (via imageCache)');

// Use a key prefix unlikely to conflict with real keys.
const PREFIX = '__tc__evict__';

test('eviction: inserting > max evicts the oldest entry', () => {
  // Insert IMAGE_CACHE_SIZE entries under our prefix.
  // Key 0 will be the oldest.
  for (let i = 0; i < IMAGE_CACHE_SIZE; i++) {
    imageCache.set(`${PREFIX}${i}`, { nativeBytes: Buffer.alloc(1) });
  }

  // All IMAGE_CACHE_SIZE entries should be present now.
  for (let i = 0; i < IMAGE_CACHE_SIZE; i++) {
    assert.notEqual(
      imageCache.get(`${PREFIX}${i}`),
      undefined,
      `entry ${i} should be present before eviction`,
    );
  }

  // Re-insert key 0 via get to promote it (we'll test recency separately,
  // but here we need key 0 to be the oldest, so skip the get).
  // Insert one more entry — this should evict the oldest (key 0).
  imageCache.set(`${PREFIX}${IMAGE_CACHE_SIZE}`, { nativeBytes: Buffer.alloc(1) });

  // Key 0 (the oldest, never touched after insertion) must be evicted.
  assert.equal(
    imageCache.get(`${PREFIX}0`),
    undefined,
    'oldest entry (key 0) should have been evicted',
  );

  // The most recently inserted key must still be present.
  assert.notEqual(
    imageCache.get(`${PREFIX}${IMAGE_CACHE_SIZE}`),
    undefined,
    'newest entry should still be present after eviction',
  );
});

const PREFIX2 = '__tc__recency__';

test('recency: get promotes a key so it survives the next eviction', () => {
  // Fill the cache to exactly max capacity under a fresh prefix.
  for (let i = 0; i < IMAGE_CACHE_SIZE; i++) {
    imageCache.set(`${PREFIX2}${i}`, { nativeBytes: Buffer.alloc(1) });
  }

  // Promote key 0 by reading it — this should move it to the MRU position.
  const promoted = imageCache.get(`${PREFIX2}0`);
  assert.notEqual(promoted, undefined, 'key 0 must exist before promotion test');

  // Now insert one more entry. Without the get, key 0 would be evicted (it was
  // the oldest). With the get, key 1 becomes the oldest and should be evicted.
  imageCache.set(`${PREFIX2}${IMAGE_CACHE_SIZE}`, { nativeBytes: Buffer.alloc(1) });

  // Key 0 was promoted so it should survive.
  assert.notEqual(
    imageCache.get(`${PREFIX2}0`),
    undefined,
    'promoted key 0 must survive the next eviction',
  );

  // Key 1 was the least-recently-used after the promotion, so it should be evicted.
  assert.equal(
    imageCache.get(`${PREFIX2}1`),
    undefined,
    'un-touched key 1 should have been evicted instead',
  );
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
// @ts-ignore — tjs is a runtime global
tjs.exit(failed > 0 ? 1 : 0);
