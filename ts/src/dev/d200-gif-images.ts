import { GLYPHS } from './d200-wide-images.js';
import { encodeGif, type GifFrame, type Rgb } from './gif-encoder.js';

// Test GIFs for d200-gif-probe.ts, drawn pixel by pixel so the probe needs no assets.

const PALETTE: readonly Rgb[] = [
  [0, 0, 0],
  [255, 255, 255],
  [220, 30, 30],
  [30, 180, 30],
  [40, 80, 255],
  [230, 200, 0],
  [0, 200, 200],
  [210, 0, 210],
];
const WHITE = 1;
/** Frame backgrounds in order: red, green, blue, yellow, cyan, magenta. */
const BACKGROUNDS = [2, 3, 4, 5, 6, 7];

interface Canvas {
  w: number;
  h: number;
  px: Uint8Array;
}

function fillRect(cv: Canvas, x: number, y: number, w: number, h: number, c: number): void {
  for (let yy = Math.max(0, y); yy < Math.min(cv.h, y + h); yy++) {
    cv.px.fill(c, yy * cv.w + Math.max(0, x), yy * cv.w + Math.min(cv.w, x + w));
  }
}

function drawDigits(cv: Canvas, text: string, scale: number, c: number): void {
  const tw = text.length * 4 * scale - scale;
  let x = Math.floor((cv.w - tw) / 2);
  const y = Math.floor((cv.h - 5 * scale) / 2);
  for (const ch of text) {
    GLYPHS[ch]?.forEach((row, r) => {
      for (let col = 0; col < 3; col++) {
        if (row[col] === '#') fillRect(cv, x + col * scale, y + r * scale, scale, scale, c);
      }
    });
    x += 4 * scale;
  }
}

export interface GifSpec {
  w: number;
  h: number;
  frames: number;
  delayCs: number;
  loop: boolean;
  /** Start colour/number offset, so many keys running the same GIF are told apart. */
  phase?: number;
  /** Pre-turn the picture 180° (AKP05 firmware shows uploads upside down). */
  rotate180?: boolean;
}

/** Frame i: solid colour, big frame number, a white bar sweeping left to right
 *  along the bottom, and a white square top-left (upright check). */
function frame(spec: GifSpec, i: number): GifFrame {
  const cv: Canvas = { w: spec.w, h: spec.h, px: new Uint8Array(spec.w * spec.h) };
  const n = (i + (spec.phase ?? 0)) % spec.frames;
  fillRect(cv, 0, 0, cv.w, cv.h, BACKGROUNDS[n % BACKGROUNDS.length]!);
  fillRect(cv, 8, 8, 24, 24, WHITE);
  drawDigits(cv, String(n + 1), Math.floor(Math.min(cv.h, cv.w) / 10), WHITE);
  const barW = Math.max(8, Math.floor(cv.w / spec.frames));
  fillRect(cv, n * barW, cv.h - 20, barW, 14, WHITE);
  // Reversing row-major pixels is a 180° turn, for panels mounted upside down.
  if (spec.rotate180) cv.px.reverse();
  return { indices: cv.px, delayCs: spec.delayCs };
}

const cache = new Map<string, Uint8Array>();
export function gifBytes(spec: GifSpec): Uint8Array {
  const key = JSON.stringify(spec);
  let bytes = cache.get(key);
  if (!bytes) {
    const frames = Array.from({ length: spec.frames }, (_, i) => frame(spec, i));
    bytes = encodeGif(spec.w, spec.h, PALETTE, frames, { loop: spec.loop });
    cache.set(key, bytes);
  }
  return bytes;
}
