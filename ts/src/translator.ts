import type { DeviceImageSpec, DeviceModel } from './devices/driver.js';
import type { ImageModeOverride } from './types.js';
import { load, closeImageProc } from './ffi/image-proc.js';

/** mk2 key index → device wire image id, driven by model.keyMap.
 *  Precedence: explicit array > offset > identity. */
export function mk2IndexToDeviceImgId(mk2Index: number, model: DeviceModel): number {
  const { coraToWireImage, imageOffset } = model.keyMap;
  if (coraToWireImage) return coraToWireImage[mk2Index] ?? -1; // OOB / unused → -1
  if (imageOffset != null) return mk2Index + imageOffset;
  return mk2Index;
}

/** Device input wire code → mk2 index, driven by model.keyMap.
 *  Precedence: explicit array > offset > identity. Returns -1 for entries the
 *  array marks as unused (e.g. 293S 6th-column keys). */
export function deviceInputToMk2Index(code: number, model: DeviceModel): number {
  const { wireInputToCora, inputOffset } = model.keyMap;
  if (wireInputToCora) return wireInputToCora[code] ?? -1;
  if (inputOffset != null) return code - inputOffset;
  return code;
}

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

function callImageProc(
  bytes: Uint8Array,
  width: number,
  height: number,
  maxBytes: number,
  quality: number,
  skipResize: boolean,
  rotate: number,
  flipH: boolean,
  flipV: boolean,
  bmp: boolean,
  bmpPpm: number,
  blurSigma: number,
  resizeFilter: number,
  sharpenSigma: number,
  fillMode: number,
  cropPx: number,
): Buffer {
  const { symbols } = load();
  for (;;) {
    const n = symbols.image_proc_transform(
      bytes,
      bytes.length,
      width,
      height,
      maxBytes,
      Math.round(quality * 100),
      skipResize ? 1 : 0,
      rotate,
      flipH ? 1 : 0,
      flipV ? 1 : 0,
      bmp ? 1 : 0,
      bmpPpm,
      Math.round(blurSigma * 10),
      resizeFilter,
      Math.round(sharpenSigma * 10),
      fillMode,
      cropPx,
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
  return callImageProc(
    jpeg,
    spec.width,
    spec.height,
    spec.maxBytes,
    spec.quality,
    false,
    spec.rotate,
    spec.flipH,
    spec.flipV,
    spec.format === 'bmp',
    spec.bmpPpm ?? 2835,
    spec.blur ?? 0,
    resizeFilterFor(spec),
    spec.sharpen ?? 0,
    fillModeFor(spec),
    spec.crop ?? 0,
  );
}

/** Close the image-proc dylib handle. Kept for backwards-compatibility with
 *  mirabox-smoke.ts and any other importer of the old `closeSidecar` name. */
export function closeSidecar(): void {
  closeImageProc();
}
