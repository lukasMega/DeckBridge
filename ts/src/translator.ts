import type { DeviceImageSpec } from './devices/driver.js';
import type { ImageModeOverride } from './types.js';
import { load, closeImageProc } from './ffi/image-proc.js';
// mk2IndexToDeviceImgId/deviceInputToMk2Index/deviceInputToExtraKey moved to
// key-map.ts (pure, no ffi) so main-thread and worker code can use them without
// pulling in this file's ffi/image-proc.js dependency.

// Reusable scratch buffers — safe because FFI calls are synchronous on the single
// JS thread and the result is copied into a fresh Buffer before returning. No await
// can interleave between the native call and the copy-out. OUT may grow (doubling)
// if image_proc_transform returns -2 (out_cap too small); the grown buffer persists
// for subsequent calls, up to OUT_MAX_BYTES.
let OUT = new Uint8Array(256 * 1024); // worst case ~19 KB (Mini 80×80 BMP)
const ERR = new Uint8Array(256);
const OUT_MAX_BYTES = 4 * 1024 * 1024; // hard cap on scratch-buffer growth

/** Throw for a non-(-2) error result from image_proc_transform, decoding ERR if present. */
function throwImageProcError(n: number): never {
  const end = ERR.indexOf(0);
  throw new Error(
    new TextDecoder().decode(ERR.subarray(0, end < 0 ? ERR.length : end)) ||
      `image_proc error ${n}`,
  );
}

/** Double OUT for a -2 (out_cap too small) retry, or throw past OUT_MAX_BYTES. */
function growOut(): void {
  if (OUT.length >= OUT_MAX_BYTES) {
    throw new Error('image_proc output exceeds 4 MB cap');
  }
  OUT = new Uint8Array(OUT.length * 2);
}

/** Map a DeviceImageSpec's resizeFilter to the FFI `resize_filter: u32` enum.
 *  0 = Triangle (default), 1 = Nearest, 2 = Lanczos3. */
export function resizeFilterFor(spec: DeviceImageSpec): number {
  switch (spec.resizeFilter) {
    case 'nearest':
      return 1;
    case 'lanczos3':
      return 2;
    default:
      return 0;
  }
}

/** Map a DeviceImageSpec's resizeMode/padFill to the FFI `fill_mode: u32` enum.
 *  0 = resize (default); 1 = pad-black; 2 = pad-average; 3 = pad-edge-clamp. */
export function fillModeFor(spec: DeviceImageSpec): number {
  if ((spec.resizeMode ?? 'resize') !== 'pad') return 0;
  switch (spec.padFill ?? 'edge') {
    case 'black':
      return 1;
    case 'average':
      return 2;
    default:
      return 3; // 'edge'
  }
}

/** Overlay a WebUI runtime image-mode override onto a DeviceImageSpec, returning
 *  the effective spec. `null` (no override) returns `spec` unchanged — the
 *  model default applies. Otherwise overlays `resizeMode`/`padFill` derived
 *  from the override, leaving all other fields (size, rotate, quality, ...)
 *  untouched. */
export function applyOverride(spec: DeviceImageSpec, mode: ImageModeOverride): DeviceImageSpec {
  switch (mode) {
    case null:
      return spec;
    case 'resize':
      return { ...spec, resizeMode: 'resize' };
    case 'pad-black':
      return { ...spec, resizeMode: 'pad', padFill: 'black' };
    case 'pad-average':
      return { ...spec, resizeMode: 'pad', padFill: 'average' };
    case 'pad-edge':
      return { ...spec, resizeMode: 'pad', padFill: 'edge' };
  }
}

/** Transform a CORA JPEG for an Elgato device according to its DeviceImageSpec.
 *  Returns JPEG bytes for gen2 (MK.2) or BMP bytes for gen1 (Mini). */
export function transformImageForDevice(jpeg: Uint8Array, spec: DeviceImageSpec): Buffer {
  const { symbols } = load();
  for (;;) {
    const n = symbols.image_proc_transform(
      jpeg,
      jpeg.length,
      spec.width,
      spec.height,
      spec.maxBytes,
      Math.round(spec.quality * 100),
      0, // skip_resize: no caller needs it
      spec.rotate,
      spec.flipH ? 1 : 0,
      spec.flipV ? 1 : 0,
      spec.format === 'bmp' ? 1 : 0,
      spec.bmpPpm ?? 2835,
      Math.round((spec.blur ?? 0) * 10),
      resizeFilterFor(spec),
      Math.round((spec.sharpen ?? 0) * 10),
      fillModeFor(spec),
      spec.crop ?? 0,
      // Region crop unused: touch-strip zones are sliced from the canvas (canvasSliceToBmp).
      0,
      0,
      0,
      0,
      OUT,
      OUT.length,
      ERR,
      ERR.length,
    );
    if (n === -2) {
      growOut();
      continue;
    }
    if (n < 0) throwImageProcError(n);
    return Buffer.from(OUT.subarray(0, n));
  }
}

/** Decode `image` (JPEG/BMP) into the top-down RGB24 `canvas` (cw×ch) at (x, y),
 *  clipped to the canvas. */
export function blitImage(
  canvas: Uint8Array,
  cw: number,
  ch: number,
  image: Uint8Array,
  x: number,
  y: number,
): void {
  const n = load().symbols.image_proc_blit(
    canvas,
    cw,
    ch,
    image,
    image.length,
    x,
    y,
    ERR,
    ERR.length,
  );
  if (n < 0) throwImageProcError(n);
}

/** 24-bit BMP of the canvas columns [x, x + w) — the image transform's input format
 *  for one touch-strip zone. Rows are bottom-up BGR, padded to 4 bytes. */
export function canvasSliceToBmp(
  canvas: Uint8Array,
  cw: number,
  ch: number,
  x: number,
  w: number,
): Uint8Array {
  const rowBytes = (w * 3 + 3) & ~3;
  const bmp = new Uint8Array(54 + rowBytes * ch);
  const view = new DataView(bmp.buffer);
  bmp[0] = 0x42;
  bmp[1] = 0x4d;
  view.setUint32(2, bmp.length, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, w, true);
  view.setInt32(22, ch, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  for (let row = 0; row < ch; row++) {
    const src = (row * cw + x) * 3;
    const dst = 54 + (ch - 1 - row) * rowBytes;
    for (let col = 0; col < w; col++) {
      bmp[dst + col * 3] = canvas[src + col * 3 + 2]!;
      bmp[dst + col * 3 + 1] = canvas[src + col * 3 + 1]!;
      bmp[dst + col * 3 + 2] = canvas[src + col * 3]!;
    }
  }
  return bmp;
}

/** Close the image-proc dylib handle. Kept for backwards-compatibility with
 *  mirabox-smoke.ts and any other importer of the old `closeSidecar` name. */
export function closeSidecar(): void {
  closeImageProc();
}
