import { IMAGE_CACHE_SIZE } from './types.js';

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
// ~2 ms FNV loop is negligible beside the 50–200 ms native image transform.
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
export function makeCacheKey(modelId: string, jpegHash: string, mode = 'def'): string {
  return `${modelId}:${mode}:${jpegHash}`;
}

export const imageCache = new LruCache<string, CacheEntry>(IMAGE_CACHE_SIZE);
