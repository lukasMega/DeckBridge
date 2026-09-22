/** Worker-side image rendering: transform a CORA image to the device-native
 *  format, cache it, and write it to the device. Runs on the USB worker thread
 *  so the synchronous FFI transform and hid_write burst never stall the main thread's
 *  CORA ACK loop or the WebUI (P1). The main thread forwards raw CORA bytes via
 *  the 'image' worker message; this module owns the transform + the LRU cache. */
import { debug, info, warn } from './logger.js';
import {
  applyOverride,
  mk2IndexToDeviceImgId,
  transformImageForDevice,
  transformImageRegion,
} from './translator.js';
import { imageCache, hashJpeg, makeCacheKey, specRevision } from './image-cache.js';
import type { DeviceModel } from './devices/driver.js';
import type { ImageModeOverride, TouchWindowRegion } from './types.js';
import { PLUS_TOUCH_WIDTH, PLUS_TOUCH_HEIGHT } from './types.js';

/** The slice of a driver this module needs: the native-bytes write. The model
 *  is passed separately because the low-level drivers keep `model` private. */
interface RenderTarget {
  sendImage(keyIndex: number, bytes: Uint8Array): void;
}

// Diagnostic image dumps. Both are off unless their env var is set, checked once at
// module load so the normal case has zero overhead.

/** Resolve a dump dir from `envVar`, creating it in the background. */
function dumpDir(envVar: string): string | undefined {
  const dir = tjs.env[envVar] || undefined;
  if (!dir) return undefined;
  tjs.makeDir(dir, { recursive: true }).catch((err: unknown) => {
    // An already-existing dump dir is success, not a failure to warn about.
    const msg = String(err);
    if (!msg.includes('EEXIST')) warn('image', `failed to create ${envVar} ${dir}: ${msg}`);
  });
  return dir;
}

function writeDump(path: string, bytes: Uint8Array): void {
  tjs.writeFile(path, bytes).catch((err: unknown) => {
    warn('image', `failed to write dump ${path}: ${String(err)}`);
  });
}

function seqTag(seq: number): string {
  return String(seq).padStart(4, '0');
}

// DECKBRIDGE_DUMP_DIR: every device-bound image produced by the transform, for
// offline diffing.
const DUMP_DIR = dumpDir('DECKBRIDGE_DUMP_DIR');
let _dumpSeq = 0;

function dumpNativeBytes(keyIndex: number, nativeBytes: Buffer): void {
  if (!DUMP_DIR) return;
  writeDump(`${DUMP_DIR}/key${keyIndex}-${seqTag(_dumpSeq++)}.jpg`, nativeBytes);
}

// DECKBRIDGE_RAW_DUMP_DIR: dumps each received CORA image beside its transform result,
// paired by seq, newest RAW_DUMP_KEEP kept as a ring buffer. Pairing is race-free because
// both writes happen on the worker thread, which processes images serially. Independent
// of DECKBRIDGE_DUMP_DIR (transform output only, own naming).
const RAW_DUMP_DIR = dumpDir('DECKBRIDGE_RAW_DUMP_DIR');
const RAW_DUMP_KEEP = 30;
let _rawSeq = 0;
// Each entry holds the file paths written for one received image (raw, then its
// transform). Newest last; pruned to RAW_DUMP_KEEP entries on each new arrival.
const _rawDumpPairs: string[][] = [];

function dumpExt(format: 'jpeg' | 'bmp'): string {
  return format === 'jpeg' ? 'jpg' : 'bmp';
}

/** Save the raw CORA image, assign it a seq, and prune the ring. Returns a
 *  handle (seq + this pair's file list) so the caller can attach the transform
 *  output, or null when DECKBRIDGE_RAW_DUMP_DIR is unset. */
function dumpRawReceived(
  keyIndex: number,
  coraBytes: Uint8Array,
  format: 'jpeg' | 'bmp',
): { seq: number; files: string[] } | null {
  if (!RAW_DUMP_DIR) return null;
  const seq = _rawSeq++;
  const inPath = `${RAW_DUMP_DIR}/${seqTag(seq)}_key${keyIndex}_in.${dumpExt(format)}`;
  writeDump(inPath, coraBytes);
  const files = [inPath];
  _rawDumpPairs.push(files);
  while (_rawDumpPairs.length > RAW_DUMP_KEEP) {
    const old = _rawDumpPairs.shift()!;
    for (const p of old) tjs.remove(p).catch(() => undefined);
  }
  return { seq, files };
}

/** Save the device-bound transform output beside its raw input (same seq). */
function dumpTransformed(
  handle: { seq: number; files: string[] } | null,
  keyIndex: number,
  nativeBytes: Uint8Array,
  devFormat: 'jpeg' | 'bmp',
): void {
  if (!handle) return;
  const outPath = `${RAW_DUMP_DIR}/${seqTag(handle.seq)}_key${keyIndex}_out.${dumpExt(devFormat)}`;
  writeDump(outPath, nativeBytes);
  handle.files.push(outPath);
}

// Worker-side render performance tracking
// Logs first-image → 15th-image device-side latency (transform + write) so the
// device batch can be compared against the main-thread "WebUI 15-key batch".
const PERF_BATCH_N = 15;
let _pt0 = 0;
let _pCount = 0;
let _pIdleTimer: number | null = null;

function perfReset(): void {
  _pt0 = 0;
  _pCount = 0;
  if (_pIdleTimer !== null) clearTimeout(_pIdleTimer);
  _pIdleTimer = null;
}

function perfOnRender(transformMs: number): void {
  const now = Date.now();
  if (!_pt0) _pt0 = now;
  if (++_pCount === PERF_BATCH_N) {
    info('perf', `device 15-key batch: +${now - _pt0}ms total; last transform ${transformMs}ms`);
    perfReset();
    return;
  }
  if (_pIdleTimer !== null) clearTimeout(_pIdleTimer);
  _pIdleTimer = setTimeout(perfReset, 3000);
}

// Device-tuning revision of the model's image spec, mixed into the cache key so
// an override change can't be served a stale entry. Memoized per model object:
// applyModelOverrides() returns a NEW object whenever the spec changes, so a
// WeakMap hit is exactly "same effective spec as last time".
const _specRevisions = new WeakMap<DeviceModel, string>();

function revisionFor(model: DeviceModel): string {
  let rev = _specRevisions.get(model);
  if (rev === undefined) {
    rev = specRevision(model.image);
    _specRevisions.set(model, rev);
  }
  return rev;
}

/** Transform (if needed), cache, key-remap, and write one CORA image to the
 *  device. Resolves once the device write has been dispatched; throws on a
 *  transform failure (the worker turns that into an 'error' message). */
export function renderImage(
  driver: RenderTarget,
  model: DeviceModel,
  keyIndex: number,
  coraBytes: Uint8Array,
  format: 'jpeg' | 'bmp',
  override: ImageModeOverride = null,
): Promise<void> {
  // Capture the raw input first so it's saved even if the transform throws.
  const rawDump = dumpRawReceived(keyIndex, coraBytes, format);

  // Effective image spec: model default, overlaid with any WebUI runtime
  // override (null = model default unchanged). The override discriminator
  // goes into the cache key so a mode switch can't serve a stale entry.
  const eff = applyOverride(model.image, override);
  const hash = makeCacheKey(model.id, hashJpeg(coraBytes), override ?? 'def', revisionFor(model));
  let entry = imageCache.get(hash);

  if (!entry) {
    const tStart = Date.now();
    let nativeBytes: Buffer;

    // Forward the input bytes unchanged when no re-encode is needed: either a
    // true gen1 device (the desktop already sent native BMP) or a model whose
    // CORA JPEG is already in the correct device format ('passthrough').
    if ((format === 'bmp' && eff.format === 'bmp') || eff.transform === 'passthrough') {
      nativeBytes = Buffer.from(coraBytes);
      perfOnRender(0);
    } else {
      // Includes K1 Pro: advertised as a Mini, so the app sends gen1 BMP, but the
      // device needs JPEG — decode the BMP and re-encode to native.
      // (image::load_from_memory auto-detects BMP vs JPEG input.)
      nativeBytes = transformImageForDevice(coraBytes, eff);
      perfOnRender(Date.now() - tStart);
    }

    // debug, not info: fires on every cache-miss transform (once per frame on any
    // animated key) and each info line becomes a WS broadcast. The 15-key batch perf
    // counters above stay at info — they are the shipped evidence.
    debug('image', `key=${keyIndex} jpeg=${nativeBytes.length}B q=${eff.quality}`);
    dumpNativeBytes(keyIndex, nativeBytes);
    entry = { nativeBytes };
    imageCache.set(hash, entry);
  } else {
    perfOnRender(0);
  }

  // Pair the device-bound bytes with the raw input under one seq (cache hit or miss).
  dumpTransformed(rawDump, keyIndex, entry.nativeBytes, model.image.format);

  // Map CORA key index → device-native key index (identity when no keyMap).
  const deviceKeyIndex =
    model.keyMap.coraToWireImage || model.keyMap.imageOffset != null
      ? mk2IndexToDeviceImgId(keyIndex, model)
      : keyIndex;
  if (deviceKeyIndex < 0) {
    warn('image', `skipping image for out-of-range key ${keyIndex}`);
    return Promise.resolve();
  }

  driver.sendImage(deviceKeyIndex, entry.nativeBytes);
  return Promise.resolve();
}

/** Render a Stream Deck + window image to the device's touch-segment displays.
 *  A full-window image (or no region) is split left-to-right into one slice per
 *  segment; a partial-window region is rendered only into the segments it overlaps
 *  (best-effort — a region not aligned to segment boundaries is stretched to fill
 *  the segment, since each segment is a full 128×128 display). */
export function renderTouchStrip(
  driver: RenderTarget,
  model: DeviceModel,
  bytes: Uint8Array,
  region?: TouchWindowRegion,
): void {
  const displays = model.widgetDisplays;
  if (!displays || displays.length === 0) return;
  const sliceWidth = Math.floor(PLUS_TOUCH_WIDTH / displays.length);
  // Full window: source is the whole 800×100 strip — slice it per segment.
  const fullWindow = !region || (region.x === 0 && region.w >= PLUS_TOUCH_WIDTH);
  for (let i = 0; i < displays.length; i++) {
    const display = displays[i]!;
    let crop: { x: number; y: number; width: number; height: number };
    if (fullWindow) {
      crop = { x: i * sliceWidth, y: 0, width: sliceWidth, height: PLUS_TOUCH_HEIGHT };
    } else {
      const segStart = i * sliceWidth;
      const segEnd = segStart + sliceWidth;
      const overlapStart = Math.max(region.x, segStart);
      const overlapEnd = Math.min(region.x + region.w, segEnd);
      if (overlapStart >= overlapEnd) continue;
      crop = {
        x: overlapStart - region.x,
        y: 0,
        width: overlapEnd - overlapStart,
        height: region.h,
      };
    }
    try {
      const native = transformImageRegion(bytes, display.image, crop);
      driver.sendImage(display.wireId, native);
    } catch (err) {
      warn('touch', `touch segment ${i} render failed: ${(err as Error).message}`);
    }
  }
}
