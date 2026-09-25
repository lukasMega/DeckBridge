// tjs:ffi bindings for libdeckbridge_native (in-process cdylib, DECKBRIDGE_NATIVE_LIB).
import FFI from 'tjs:ffi';
import { BUFFER, SIZE_T, UINT32, INT } from './hidapi.ts';

const DECKBRIDGE_NATIVE_LIB = 'DECKBRIDGE_NATIVE_LIB';

interface ImageProcSymbols {
  image_proc_transform(
    jpegIn: Uint8Array,
    jpegInLen: number,
    width: number,
    height: number,
    maxBytes: number,
    quality: number,
    skipResize: number,
    rotate: number,
    flipH: number,
    flipV: number,
    format: number,
    bmpPpm: number,
    blurSigmaTenths: number, // sigma × 10; 0 = no blur
    resizeFilter: number, // 0 = Triangle (default), 1 = Nearest
    sharpenSigmaTenths: number, // sigma × 10; 0 = no sharpen
    fillMode: number, // 0 = resize; 1 = pad-black; 2 = pad-average; 3 = pad-edge-clamp
    cropPx: number, // pixels cropped from every source side before resize; 0 = none
    cropX: number, // region-crop left offset (used when cropW/cropH > 0)
    cropY: number, // region-crop top offset
    cropW: number, // region-crop width (0 = no region crop)
    cropH: number, // region-crop height (0 = no region crop)
    outBuf: Uint8Array,
    outCap: number,
    errBuf: Uint8Array,
    errCap: number,
  ): number;
  image_proc_blit(
    canvas: Uint8Array, // top-down RGB24, cw × ch × 3 bytes, written in place
    cw: number,
    ch: number,
    input: Uint8Array,
    inputLen: number,
    x: number,
    y: number,
    errBuf: Uint8Array,
    errCap: number,
  ): number;
}

let lib: { symbols: ImageProcSymbols; close(): void } | null = null;

export function load(): { symbols: ImageProcSymbols; close(): void } {
  if (lib) return lib;

  const path = (typeof tjs !== 'undefined' ? tjs.env[DECKBRIDGE_NATIVE_LIB] : undefined) ?? '';
  if (!path) throw new Error(`${DECKBRIDGE_NATIVE_LIB} not set`);
  /* prettier-ignore */
  lib = FFI.dlopen(path, {
    image_proc_transform: {
      args: [
        BUFFER, SIZE_T,
        UINT32, UINT32,
        SIZE_T, UINT32, INT,
        UINT32, INT, INT, INT, INT,
        UINT32,
        UINT32,
        UINT32,
        UINT32,
        UINT32,
        UINT32,
        UINT32,
        UINT32,
        UINT32,
        BUFFER, SIZE_T,
        BUFFER, SIZE_T,
      ],
      returns: INT,
    },
    image_proc_blit: {
      args: [BUFFER, UINT32, UINT32, BUFFER, SIZE_T, UINT32, UINT32, BUFFER, SIZE_T],
      returns: INT,
    },
  }) as unknown as { symbols: ImageProcSymbols; close(): void };
  return lib;
}

export function closeImageProc(): void {
  lib?.close();
  lib = null;
}
