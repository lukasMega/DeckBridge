import { ULANZI_D200_MODEL } from '../devices/ulanzi/ulanzi-d200.js';
import type { DeviceImageSpec } from '../devices/driver.js';
import { canvasSliceToBmp, transformImageForDevice } from '../transform/translator.js';

// Test images for d200-wide-probe.ts, drawn pixel by pixel so the probe needs no assets.

const model = ULANZI_D200_MODEL;

type Rgb = readonly [number, number, number];
interface Canvas {
  w: number;
  h: number;
  rgb: Uint8Array;
}
export interface IconSpec {
  w: number;
  h: number;
  format: 'png' | 'jpeg';
}

const BG: Rgb = [16, 16, 24];
const GRID: Rgb = [48, 48, 72];
const GRID_MAJOR: Rgb = [90, 90, 130];
const WHITE: Rgb = [255, 255, 255];
const CYAN: Rgb = [0, 220, 220];
const MAGENTA: Rgb = [230, 0, 230];
const RED: Rgb = [230, 30, 30];
const GREEN: Rgb = [30, 200, 30];
const BLUE: Rgb = [40, 80, 255];
const YELLOW: Rgb = [240, 220, 0];

// 3x5 pixel font: digits and 'x' are all a size label needs.
const GLYPHS: Record<string, readonly string[]> = {
  '0': ['###', '# #', '# #', '# #', '###'],
  '1': [' # ', '## ', ' # ', ' # ', '###'],
  '2': ['###', '  #', '###', '#  ', '###'],
  '3': ['###', '  #', '###', '  #', '###'],
  '4': ['# #', '# #', '###', '  #', '  #'],
  '5': ['###', '#  ', '###', '  #', '###'],
  '6': ['###', '#  ', '###', '# #', '###'],
  '7': ['###', '  #', '  #', '  #', '  #'],
  '8': ['###', '# #', '###', '# #', '###'],
  '9': ['###', '# #', '###', '  #', '###'],
  x: ['   ', '# #', ' # ', '# #', '   '],
};

function fillRect(cv: Canvas, x: number, y: number, w: number, h: number, c: Rgb): void {
  for (let yy = Math.max(0, y); yy < Math.min(cv.h, y + h); yy++) {
    for (let xx = Math.max(0, x); xx < Math.min(cv.w, x + w); xx++) {
      cv.rgb.set(c, (yy * cv.w + xx) * 3);
    }
  }
}

function drawText(cv: Canvas, text: string, x: number, y: number, scale: number, c: Rgb): void {
  let cx = x;
  for (const ch of text) {
    GLYPHS[ch]?.forEach((row, r) => {
      for (let col = 0; col < 3; col++) {
        if (row[col] === '#') fillRect(cv, cx + col * scale, y + r * scale, scale, scale, c);
      }
    });
    cx += 4 * scale;
  }
}

function tickLen(v: number): number {
  if (v % 100 === 0) return 24;
  return v % 50 === 0 ? 14 : 6;
}

/** Ruler + grid: ticks every 10 px on all four edges, numbers every 100 px, a
 *  1 px white border (cropping removes it), colored corner squares (orientation
 *  and mirroring) and lines at x=196 / x=392 (the cell boundaries of "3_2"+"4_2"). */
function rulerCanvas(w: number, h: number): Canvas {
  const cv: Canvas = { w, h, rgb: new Uint8Array(w * h * 3) };
  fillRect(cv, 0, 0, w, h, BG);
  for (let x = 0; x < w; x += 50) fillRect(cv, x, 0, 1, h, x % 100 === 0 ? GRID_MAJOR : GRID);
  for (let y = 0; y < h; y += 50) fillRect(cv, 0, y, w, 1, y % 100 === 0 ? GRID_MAJOR : GRID);
  if (w > 196) fillRect(cv, 195, 0, 2, h, CYAN);
  if (w > 392) fillRect(cv, 391, 0, 2, h, MAGENTA);
  for (let x = 0; x < w; x += 10) {
    fillRect(cv, x, 0, 1, tickLen(x), WHITE);
    fillRect(cv, x, h - tickLen(x), 1, tickLen(x), WHITE);
  }
  for (let y = 0; y < h; y += 10) {
    fillRect(cv, 0, y, tickLen(y), 1, WHITE);
    fillRect(cv, w - tickLen(y), y, tickLen(y), 1, WHITE);
  }
  fillRect(cv, 0, 0, w, 1, WHITE);
  fillRect(cv, 0, h - 1, w, 1, WHITE);
  fillRect(cv, 0, 0, 1, h, WHITE);
  fillRect(cv, w - 1, 0, 1, h, WHITE);
  fillRect(cv, 28, 28, 14, 14, RED);
  fillRect(cv, w - 42, 28, 14, 14, GREEN);
  fillRect(cv, 28, h - 42, 14, 14, BLUE);
  fillRect(cv, w - 42, h - 42, 14, 14, YELLOW);
  for (let x = 100; x < w; x += 100) drawText(cv, String(x), x + 3, 28, 2, WHITE);
  for (let y = 100; y < h; y += 100) drawText(cv, String(y), 28, y + 3, 2, WHITE);
  const label = `${w}x${h}`;
  const lw = label.length * 16 - 4;
  fillRect(cv, Math.floor((w - lw) / 2) - 4, 76, lw + 8, 28, BG);
  drawText(cv, label, Math.floor((w - lw) / 2), 80, 4, WHITE);
  return cv;
}

/** Same pipeline as the keys (BMP in, native encode out) but unrotated and 1:1, so
 *  what the panel shows is what was drawn. JPEG quality matches the keys. */
function encodeTestImage(spec: IconSpec): Uint8Array {
  const cv = rulerCanvas(spec.w, spec.h);
  const imageSpec: DeviceImageSpec = {
    ...model.image,
    format: spec.format,
    width: spec.w,
    height: spec.h,
    rotate: 0,
    flipH: false,
    flipV: false,
    maxBytes: 0,
    quality: 0.9,
    sharpen: 0,
    resizeFilter: 'nearest',
  };
  return transformImageForDevice(canvasSliceToBmp(cv.rgb, cv.w, cv.h, 0, cv.w), imageSpec);
}

const iconCache = new Map<string, Uint8Array>();
export function iconBytes(spec: IconSpec): Uint8Array {
  const key = `${spec.w}x${spec.h}.${spec.format}`;
  let bytes = iconCache.get(key);
  if (!bytes) {
    bytes = encodeTestImage(spec);
    iconCache.set(key, bytes);
  }
  return bytes;
}
