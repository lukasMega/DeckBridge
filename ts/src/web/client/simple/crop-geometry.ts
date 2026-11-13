// Pure crop-rect geometry for the image crop editor. Source pixels throughout;
// bounds mirror model-overrides.ts (width/height ≥ 8) and transform.rs (clamp to source).
import type { DeviceCropRect } from '../ui-types.js';
import type { Size } from './image-fit-help.js';

export const MIN_CROP = 8;

export type Corner = 'nw' | 'ne' | 'sw' | 'se';

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/** Integral rect inside the source, at least MIN_CROP (or the source) on each axis. */
export function clampRect(r: DeviceCropRect, src: Size): DeviceCropRect {
  const width = clamp(Math.round(r.width), Math.min(MIN_CROP, src.width), src.width);
  const height = clamp(Math.round(r.height), Math.min(MIN_CROP, src.height), src.height);
  return {
    x: clamp(Math.round(r.x), 0, src.width - width),
    y: clamp(Math.round(r.y), 0, src.height - height),
    width,
    height,
  };
}

export function moveRect(r: DeviceCropRect, dx: number, dy: number, src: Size): DeviceCropRect {
  return clampRect({ ...r, x: r.x + dx, y: r.y + dy }, src);
}

/** Largest rect of `aspect` (w/h) that fits the source, centred. */
function largestOfAspect(src: Size, aspect: number): Size {
  return src.width / src.height > aspect
    ? { width: Math.round(src.height * aspect), height: src.height }
    : { width: src.width, height: Math.round(src.width / aspect) };
}

/** Drag one corner; the opposite corner stays put. With `aspect`, height follows width. */
export function resizeFromCorner(
  r: DeviceCropRect,
  corner: Corner,
  dx: number,
  dy: number,
  src: Size,
  aspect?: number,
): DeviceCropRect {
  const west = corner === 'nw' || corner === 'sw';
  const north = corner === 'nw' || corner === 'ne';
  const right = r.x + r.width;
  const bottom = r.y + r.height;
  // Room from the fixed corner to the source edge being dragged towards.
  const maxW = west ? right : src.width - r.x;
  const maxH = north ? bottom : src.height - r.y;
  let width = clamp(r.width + (west ? -dx : dx), MIN_CROP, maxW);
  let height = clamp(r.height + (north ? -dy : dy), MIN_CROP, maxH);
  if (aspect) {
    const fit = largestOfAspect({ width: maxW, height: maxH }, aspect);
    width = clamp(width, MIN_CROP, fit.width);
    height = Math.max(MIN_CROP, Math.round(width / aspect));
  }
  return clampRect(
    {
      x: west ? right - width : r.x,
      y: north ? bottom - height : r.y,
      width,
      height,
    },
    src,
  );
}

/** `size` centred in the source (clamped to it). */
export function centredRect(size: Size, src: Size): DeviceCropRect {
  const width = Math.min(size.width, src.width);
  const height = Math.min(size.height, src.height);
  return clampRect(
    {
      x: Math.floor((src.width - width) / 2),
      y: Math.floor((src.height - height) / 2),
      width,
      height,
    },
    src,
  );
}

export function wholeImage(src: Size): DeviceCropRect {
  return { x: 0, y: 0, width: src.width, height: src.height };
}

/** Rect the editor opens with: the saved one if complete, else the key size 1:1. */
export function initialRect(
  saved: Partial<DeviceCropRect> | undefined,
  key: Size,
  src: Size,
): DeviceCropRect {
  if (
    saved?.x !== undefined &&
    saved.y !== undefined &&
    saved.width !== undefined &&
    saved.height !== undefined
  ) {
    return clampRect(saved as DeviceCropRect, src);
  }
  return centredRect(key, src);
}

/** Keep `aspect` after a numeric width/height edit. */
export function withAspect(
  r: DeviceCropRect,
  changed: 'width' | 'height',
  src: Size,
  aspect: number,
): DeviceCropRect {
  const next =
    changed === 'width'
      ? { ...r, height: Math.round(r.width / aspect) }
      : { ...r, width: Math.round(r.height * aspect) };
  return clampRect(next, src);
}

export interface DrawOp {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/** One axis of pad.rs: 1:1 centred, cropping the centre when the source is larger
 *  (crop mode) or leaving a border when it is smaller. */
function oneToOne(s: number, d: number): { s: number; d: number; len: number } {
  if (s > d) return { s: Math.floor((s - d) / 2), d: 0, len: d };
  return { s: 0, d: Math.floor((d - s) / 2), len: s };
}

/** canvas drawImage args for the key preview — an approximation of the device
 *  transform (browser filter, no sharpen, black border), shown upright. */
export function previewDrawOp(
  r: DeviceCropRect,
  key: Size,
  mode: 'resize' | 'pad' | 'crop',
): DrawOp {
  const larger = r.width > key.width || r.height > key.height;
  // pad.rs falls back to resize when the source is larger on an axis.
  if (mode === 'resize' || (mode === 'pad' && larger)) {
    return {
      sx: r.x,
      sy: r.y,
      sw: r.width,
      sh: r.height,
      dx: 0,
      dy: 0,
      dw: key.width,
      dh: key.height,
    };
  }
  const h = oneToOne(r.width, key.width);
  const v = oneToOne(r.height, key.height);
  return {
    sx: r.x + h.s,
    sy: r.y + v.s,
    sw: h.len,
    sh: v.len,
    dx: h.d,
    dy: v.d,
    dw: h.len,
    dh: v.len,
  };
}
