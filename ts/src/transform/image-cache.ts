import { fnv1aHex, IMAGE_CACHE_SIZE } from '../shared/types.js';
import type { DeviceImageSpec } from '../devices/driver.js';

export interface CacheEntry {
  nativeBytes: Buffer;
}

/** Retained-bytes ceiling beside the entry cap: a 1024² BMP is ~3 MiB, so 100 entries
 *  alone could pin ~300 MiB per worker. */
export const IMAGE_CACHE_MAX_BYTES = 32 * 1024 * 1024;

export class LruCache<K, V> {
  private readonly map = new Map<K, { value: V; size: number }>();
  private bytes = 0;
  constructor(
    private readonly max: number,
    private readonly maxBytes: number,
    private readonly sizeOf: (value: V) => number,
  ) {}

  get(key: K): V | undefined {
    const e = this.map.get(key);
    if (e === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  set(key: K, value: V): void {
    this.remove(key);
    const size = this.sizeOf(value);
    // An entry that can never fit would just flush the whole cache.
    if (size > this.maxBytes) return;
    while (this.map.size >= this.max || this.bytes + size > this.maxBytes) {
      this.remove(this.map.keys().next().value!);
    }
    this.map.set(key, { value, size });
    this.bytes += size;
  }

  private remove(key: K): void {
    const e = this.map.get(key);
    if (!e) return;
    this.bytes -= e.size;
    this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }

  get byteSize(): number {
    return this.bytes;
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }
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

export const imageCache = new LruCache<string, CacheEntry>(
  IMAGE_CACHE_SIZE,
  IMAGE_CACHE_MAX_BYTES,
  (e) => e.nativeBytes.length,
);
