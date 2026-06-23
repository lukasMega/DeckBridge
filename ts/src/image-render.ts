/** Worker-side image rendering: transform a CORA image to the device-native
 *  format, cache it, and write it to the device. Runs on the USB worker thread
 *  so the 50–200 ms synchronous FFI transform never stalls the main thread's
 *  CORA ACK loop or the WebUI (P1). The main thread forwards raw CORA bytes via
 *  the 'image' worker message; this module owns the transform + the LRU cache. */
import { info, warn } from './logger.js';
import { applyOverride, mk2IndexToDeviceImgId, transformImageForDevice } from './translator.js';
import { imageCache, hashJpeg, makeCacheKey } from './image-cache.js';
import type { DeviceModel } from './devices/driver.js';
import type { ImageModeOverride } from './types.js';

/** The slice of a driver this module needs: the native-bytes write. The model
 *  is passed separately because the low-level drivers keep `model` private. */
interface RenderTarget {
  sendImage(keyIndex: number, bytes: Uint8Array): void;
}

// --- Diagnostic JPEG dump (DECKBRIDGE_DUMP_DIR) ---
// When set, every device-bound image produced by the transform is also written
// to disk for offline diffing. Checked once at module load so the normal (unset)
// case has zero overhead.
const DUMP_DIR: string | undefined = tjs.env.DECKBRIDGE_DUMP_DIR || undefined;
let _dumpSeq = 0;

if (DUMP_DIR) {
  tjs.makeDir(DUMP_DIR, { recursive: true }).catch((err: unknown) => {
    warn('image', `failed to create DECKBRIDGE_DUMP_DIR ${DUMP_DIR}: ${String(err)}`);
  });
}

function dumpNativeBytes(keyIndex: number, nativeBytes: Buffer): void {
  if (!DUMP_DIR) return;
  const seq = String(_dumpSeq++).padStart(4, '0');
  const path = `${DUMP_DIR}/key${keyIndex}-${seq}.jpg`;
  tjs.writeFile(path, nativeBytes).catch((err: unknown) => {
    warn('image', `failed to write dump ${path}: ${String(err)}`);
  });
}

// --- Paired raw/transformed image dump (DECKBRIDGE_RAW_DUMP_DIR) ---
// When set, every CORA image received from the Elgato app is saved to disk next
// to the device-bound transform result, paired by sequence number, so the input
// the desktop sent can be diffed against what we push to the panel. Keeps the
// newest RAW_DUMP_KEEP received images (a ring buffer); older pairs are deleted.
// Both writes happen here on the worker thread — it owns both buffers and
// processes images serially, so the seq pairing is race-free. Independent of
// DECKBRIDGE_DUMP_DIR (which dumps only the transform output, with its own naming).
const RAW_DUMP_DIR: string | undefined = tjs.env.DECKBRIDGE_RAW_DUMP_DIR || undefined;
const RAW_DUMP_KEEP = 30;
let _rawSeq = 0;
// Each entry holds the file paths written for one received image (raw, then its
// transform). Newest last; pruned to RAW_DUMP_KEEP entries on each new arrival.
const _rawDumpPairs: string[][] = [];

if (RAW_DUMP_DIR) {
  tjs.makeDir(RAW_DUMP_DIR, { recursive: true }).catch((err: unknown) => {
    // An already-existing dump dir is success, not a failure to warn about.
    const msg = String(err);
    if (msg.includes('EEXIST')) return;
    warn('image', `failed to create DECKBRIDGE_RAW_DUMP_DIR ${RAW_DUMP_DIR}: ${msg}`);
  });
}

function dumpExt(format: 'jpeg' | 'bmp'): string {
  return format === 'jpeg' ? 'jpg' : 'bmp';
}

function writeRawDumpFile(path: string, bytes: Uint8Array): void {
  tjs.writeFile(path, bytes).catch((err: unknown) => {
    warn('image', `failed to write raw dump ${path}: ${String(err)}`);
  });
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
  const tag = String(seq).padStart(4, '0');
  const inPath = `${RAW_DUMP_DIR}/${tag}_key${keyIndex}_in.${dumpExt(format)}`;
  writeRawDumpFile(inPath, coraBytes);
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
  const tag = String(handle.seq).padStart(4, '0');
  const outPath = `${RAW_DUMP_DIR}/${tag}_key${keyIndex}_out.${dumpExt(devFormat)}`;
  writeRawDumpFile(outPath, nativeBytes);
  handle.files.push(outPath);
}

// --- Worker-side render performance tracking ---
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
  const hash = makeCacheKey(model.id, hashJpeg(coraBytes), override ?? 'def');
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

    info('image', `key=${keyIndex} jpeg=${nativeBytes.length}B q=${eff.quality}`);
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
