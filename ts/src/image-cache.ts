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

function fnv1aRange(buf: Uint8Array, start: number, end: number, h: number): number {
  for (let i = start; i < end; i++) {
    h ^= buf[i]!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// Hash the FULL buffer. An earlier version sampled only the first/last 4 KB for
// buffers above 8 KB, but for gen1 BMP input (80×80×3, bottom-up = ~19 KB) those
// samples cover only the top/bottom border rows. A small centred icon on a black
// background — e.g. a "back" arrow — then hashed identically to a blank black
// frame, so the cached black transform was served and the key showed up black.
// hashJpeg's only caller is the USB worker thread (image-render.ts), where this
// ~2 ms FNV loop is comparable to the ~1 ms native transform, but it also skips the
// hid_write burst on a hit, which is what actually dominates.
export function hashJpeg(buf: Uint8Array): string {
  let h = 0x811c9dc5;
  // Mix in the total length so same-prefix buffers of different lengths
  // (e.g. truncated streams) hash differently.
  h = fnv1aRange(new Uint8Array(new Uint32Array([buf.length]).buffer), 0, 4, h);
  h = fnv1aRange(buf, 0, buf.length, h);
  return h.toString(16).padStart(8, '0');
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
