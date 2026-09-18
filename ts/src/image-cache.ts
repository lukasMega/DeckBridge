import { fnv1aHex, IMAGE_CACHE_SIZE } from './types.js';
import type { DeviceImageSpec } from './devices/driver.js';

export interface CacheEntry {
  nativeBytes: Buffer;
}

class LruCache<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly max: number) {}

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value!);
    this.map.set(key, value);
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}

const FNV_PRIME = 0x01000193;

function fnv1aRange(buf: Uint8Array, start: number, end: number, h: number): number {
  for (let i = start; i < end; i++) {
    h ^= buf[i]!;
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h;
}

// murmur3 fmix32
function fmix32(h: number): number {
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

// Hashes the FULL buffer, word-wise. Sampling was tried and reverted (black-icon
// collision); byte-wise was slower than the transform it guards. Both, plus the
// xorshift and alignment caveats below: docs/image-flow.md#image-cache-hash
export function hashJpeg(buf: Uint8Array): string {
  // Length mixed in so same-prefix buffers of different lengths differ.
  let h = Math.imul(0x811c9dc5 ^ buf.length, FNV_PRIME) >>> 0;

  const len = buf.length;
  const off = buf.byteOffset;
  let i = 0;
  // Unaligned views take the byte path and digest differently — a cache miss, never a false hit.
  if ((off & 3) === 0) {
    const words = len >>> 2;
    const u32 = new Uint32Array(buf.buffer, off, words);
    for (let w = 0; w < words; w++) {
      h = Math.imul(h ^ u32[w]!, FNV_PRIME) >>> 0;
      // Load-bearing: FNV_PRIME carries bits upward only, so without this a word's
      // top-byte delta never leaves its lane. 5053 collisions per 20k without, 0 with.
      h = (h ^ (h >>> 15)) >>> 0;
    }
    i = words << 2;
  }
  h = fnv1aRange(buf, i, len, h);

  return fmix32(h).toString(16).padStart(8, '0');
}

/** Build a cache key that includes the device model and the effective image
 *  mode so that the same CORA JPEG produces separate cache entries for
 *  Mirabox, MK.2, and Mini, and so a WebUI mode override (resize ⇄ pad-*)
 *  can't serve a stale entry from a different mode. `mode` defaults to
 *  `'def'` (model default) for callers that don't track an override. */
export function makeCacheKey(modelId: string, jpegHash: string, mode = 'def', rev = ''): string {
  return `${modelId}:${mode}:${rev}:${jpegHash}`;
}

/** Short hash of an effective DeviceImageSpec, for the `rev` slot of the cache
 *  key. Without it, a user device-tuning change (rotation, quality, size — see
 *  devices/model-overrides.ts) would keep serving entries encoded under the OLD
 *  spec, and the tweak would appear to do nothing until a restart. */
export function specRevision(spec: DeviceImageSpec): string {
  return fnv1aHex(JSON.stringify(spec));
}

export const imageCache = new LruCache<string, CacheEntry>(IMAGE_CACHE_SIZE);
