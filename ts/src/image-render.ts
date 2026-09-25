/** Worker-side image rendering: transform a CORA image to the device-native
 *  format, cache it, and write it to the device. Runs on the USB worker thread
 *  so the synchronous FFI transform and hid_write burst never stall the main thread's
 *  CORA ACK loop or the WebUI (P1). The main thread forwards raw CORA bytes via
 *  the 'image' worker message; this module owns the transform + the LRU cache. */
import { debug, info, warn } from './logger.js';
import {
  applyOverride,
  blitImage,
  canvasSliceToBmp,
  transformImageForDevice,
} from './translator.js';
import { mk2IndexToDeviceImgId } from './key-map.js';
import { imageCache, hashJpeg, makeCacheKey, specRevision } from './image-cache.js';
import type { DeviceImageSpec, DeviceModel } from './devices/driver.js';
import type { ImageModeOverride, TouchStripOptions, TouchWindowRegion } from './types.js';
import { DEFAULT_TOUCH_STRIP_OPTIONS, PLUS_TOUCH_WIDTH, PLUS_TOUCH_HEIGHT } from './types.js';

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
 *  device. Returns once the device write has been dispatched; throws on a
 *  transform failure (the worker turns that into an 'error' message). */
export function renderImage(
  driver: RenderTarget,
  model: DeviceModel,
  keyIndex: number,
  coraBytes: Uint8Array,
  format: 'jpeg' | 'bmp',
  override: ImageModeOverride = null,
): void {
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
    return;
  }

  driver.sendImage(deviceKeyIndex, entry.nativeBytes);
}

/** Every strip zone a region touches: the Elgato app's 200-px zones, the same split
 *  ExtraKeyWidgets.noteTouchFrame uses. No region = the whole strip. */
function touchedZones(count: number, region?: TouchWindowRegion): number[] {
  const zoneWidth = Math.floor(PLUS_TOUCH_WIDTH / count);
  const x = region?.x ?? 0;
  const w = region?.w ?? PLUS_TOUCH_WIDTH;
  const zones: number[] = [];
  for (let i = 0; i < count; i++) {
    if (x < (i + 1) * zoneWidth && x + w > i * zoneWidth) zones.push(i);
  }
  return zones;
}

function coversStrip(region?: TouchWindowRegion): boolean {
  return (
    !region ||
    (region.x <= 0 &&
      region.y <= 0 &&
      region.x + region.w >= PLUS_TOUCH_WIDTH &&
      region.y + region.h >= PLUS_TOUCH_HEIGHT)
  );
}

/** Lossless intermediate for 'scale': the zone fitted into the slot, which the slot
 *  spec then pads. */
const ZONE_FIT_SPEC: DeviceImageSpec = {
  format: 'bmp',
  width: 0,
  height: 0,
  rotate: 0,
  flipH: false,
  flipV: false,
  colorMode: 'rgb',
  maxBytes: 0,
  quality: 1,
  resizeFilter: 'lanczos3',
  transform: 'sidecar',
};

/** One dock's Stream Deck + window (800×100, RGB). The app sends full frames and
 *  small patches (dial feedback); each is drawn into this canvas, then sent as one
 *  full-strip upload or as every zone it touches, re-sent whole — a patch sent alone
 *  would be stretched over its zone. Zones in the mask (DeckBridge widgets own them)
 *  are drawn but never sent. See docs/side-keys.md. */
export class TouchStripCanvas {
  private readonly rgb = new Uint8Array(PLUS_TOUCH_WIDTH * PLUS_TOUCH_HEIGHT * 3);
  private mask = new Set<number>();
  private options: TouchStripOptions = DEFAULT_TOUCH_STRIP_OPTIONS;

  /** A new device (or none): black strip, the app owns every zone, default options. */
  reset(): void {
    this.rgb.fill(0);
    this.mask = new Set();
    this.options = DEFAULT_TOUCH_STRIP_OPTIONS;
  }

  setOptions(options: TouchStripOptions): void {
    this.options = options;
  }

  apply(
    driver: RenderTarget,
    model: DeviceModel,
    bytes: Uint8Array,
    region?: TouchWindowRegion,
  ): void {
    const displays = model.widgetDisplays;
    if (!displays || displays.length === 0) return;
    try {
      blitImage(
        this.rgb,
        PLUS_TOUCH_WIDTH,
        PLUS_TOUCH_HEIGHT,
        bytes,
        region?.x ?? 0,
        region?.y ?? 0,
      );
    } catch (err) {
      warn('touch', `touch window blit failed: ${(err as Error).message}`);
      return;
    }
    if (this.options.upload === 'always' || coversStrip(region)) {
      if (this.sendFullStrip(driver, model)) return;
    }
    for (const i of touchedZones(displays.length, region)) {
      if (!this.mask.has(displays[i]!.wireId)) this.sendZone(driver, model, i);
    }
  }

  /** Swap in a new ownership mask; every released zone gets the app's image back. */
  setMask(driver: RenderTarget, model: DeviceModel, wireIds: readonly number[]): void {
    const released = [...this.mask].filter((wireId) => !wireIds.includes(wireId));
    this.mask = new Set(wireIds);
    this.restore(driver, model, released);
  }

  /** Put the app's image back on these zones (black where it never drew). */
  restore(driver: RenderTarget, model: DeviceModel, wireIds: readonly number[]): void {
    const displays = model.widgetDisplays ?? [];
    if (wireIds.length === 0) return;
    if (displays.every(({ wireId }) => wireIds.includes(wireId))) {
      if (this.sendFullStrip(driver, model)) return;
    }
    displays.forEach(({ wireId }, i) => {
      if (wireIds.includes(wireId)) this.sendZone(driver, model, i);
    });
  }

  /** One upload for the whole strip. False when the model has no full-strip surface
   *  or a masked zone would be painted over — the caller sends per zone instead. */
  private sendFullStrip(driver: RenderTarget, model: DeviceModel): boolean {
    const strip = model.touchStripDisplay;
    if (!strip || this.mask.size > 0) return false;
    try {
      const bmp = canvasSliceToBmp(
        this.rgb,
        PLUS_TOUCH_WIDTH,
        PLUS_TOUCH_HEIGHT,
        0,
        PLUS_TOUCH_WIDTH,
      );
      driver.sendImage(strip.wireId, transformImageForDevice(bmp, strip.image));
    } catch (err) {
      warn('touch', `touch strip render failed: ${(err as Error).message}`);
    }
    return true;
  }

  private sendZone(driver: RenderTarget, model: DeviceModel, index: number): void {
    const display = model.widgetDisplays![index]!;
    try {
      driver.sendImage(
        display.wireId,
        transformImageForDevice(this.zoneBmp(model, index), display.image),
      );
    } catch (err) {
      warn('touch', `touch segment ${index} render failed: ${(err as Error).message}`);
    }
  }

  /** The canvas part one zone shows. Without a full-strip surface the Elgato zone is
   *  stretched into its display, as before the strip geometry was known. */
  private zoneBmp(model: DeviceModel, index: number): Uint8Array {
    const displays = model.widgetDisplays!;
    const display = displays[index]!;
    const strip = model.touchStripDisplay;
    if (strip && display.stripX !== undefined && this.options.zoneFit === 'crop') {
      const ratio = PLUS_TOUCH_WIDTH / strip.image.width;
      const x = Math.round(display.stripX * ratio);
      const w = Math.min(Math.round(display.image.width * ratio), PLUS_TOUCH_WIDTH - x);
      return canvasSliceToBmp(this.rgb, PLUS_TOUCH_WIDTH, PLUS_TOUCH_HEIGHT, x, w);
    }
    const zoneWidth = Math.floor(PLUS_TOUCH_WIDTH / displays.length);
    const zone = canvasSliceToBmp(
      this.rgb,
      PLUS_TOUCH_WIDTH,
      PLUS_TOUCH_HEIGHT,
      index * zoneWidth,
      zoneWidth,
    );
    if (!strip) return zone;
    const scale = Math.min(
      display.image.width / zoneWidth,
      display.image.height / PLUS_TOUCH_HEIGHT,
    );
    return transformImageForDevice(zone, {
      ...ZONE_FIT_SPEC,
      width: Math.round(zoneWidth * scale),
      height: Math.round(PLUS_TOUCH_HEIGHT * scale),
    });
  }
}
