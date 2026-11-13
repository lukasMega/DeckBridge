// Draws a widget layout (widget-layout.ts) into a 24-bit BMP: colours, bold, outline.
import type { AlphaFont, BitmapFont, BitsFont } from '../assets/font-atlas.js';
import { fontGlyphIndex } from '../assets/font-glyph-index.js';
import { DEFAULT_TEXT_BACKGROUND, DEFAULT_TEXT_COLOR } from './extra-key-config.js';
import type { ExtraKeyTextStyle } from '../web/contract.js';
import { glyphAdvance, layoutWidget, type WidgetLayout, type WidgetLine } from './widget-layout.js';

type Bgr = readonly [number, number, number];

/** '#rrggbb' → BMP byte order. */
function bgr(hex: string): Bgr {
  const n = Number.parseInt(hex.slice(1), 16);
  return [n & 0xff, (n >> 8) & 0xff, n >> 16];
}

const decodedFonts = new Map<BitsFont, Uint8Array>();
function fontBits(font: BitsFont): Uint8Array {
  let bits = decodedFonts.get(font);
  if (!bits) {
    bits = new Uint8Array(Buffer.from(font.bits, 'latin1'));
    decodedFonts.set(font, bits);
  }
  return bits;
}

interface DecodedAlpha {
  alpha: Uint8Array;
  boxes: Uint8Array;
  /** Byte offset of each glyph in `alpha` (prefix sum over the box sizes). */
  offsets: Uint32Array;
}

const decodedAlpha = new Map<AlphaFont, DecodedAlpha>();
function fontAlpha(font: AlphaFont): DecodedAlpha {
  let d = decodedAlpha.get(font);
  if (!d) {
    const boxes = new Uint8Array(Buffer.from(font.boxes, 'latin1'));
    const offsets = new Uint32Array(boxes.length / 4);
    let at = 0;
    for (let i = 0; i < offsets.length; i++) {
      offsets[i] = at;
      at += Math.ceil(boxes[i * 4 + 2]! / 2) * boxes[i * 4 + 3]!;
    }
    d = { alpha: new Uint8Array(Buffer.from(font.alpha, 'latin1')), boxes, offsets };
    decodedAlpha.set(font, d);
  }
  return d;
}

interface Canvas {
  px: Uint8Array;
  width: number;
  height: number;
}

/** Blit one glyph (foreground pixels only) with its pen at x0; clipped to the canvas. */
function blitGlyph(
  c: Canvas,
  font: BitmapFont,
  codepoint: number,
  x0: number,
  y0: number,
  color: Bgr,
) {
  const idx = fontGlyphIndex(codepoint);
  if (idx < 0) return;
  if (font.kind === 'alpha') blitAlpha(c, font, idx, x0, y0, color);
  else blitBits(c, font, idx, x0, y0, color);
}

function blitBits(c: Canvas, font: BitsFont, idx: number, x0: number, y0: number, color: Bgr) {
  const scale = font.scale ?? 1;
  const cellW = font.width / scale;
  const cellH = font.height / scale;
  const rowBytes = Math.ceil(cellW / 8);
  const bits = fontBits(font);
  const base = idx * rowBytes * cellH;
  const left = x0 + (font.originX ?? 0);
  for (let y = 0; y < font.height; y++) {
    const py = y0 + y;
    if (py < 0 || py >= c.height) continue;
    const row = base + Math.floor(y / scale) * rowBytes;
    for (let x = 0; x < font.width; x++) {
      const sx = Math.floor(x / scale);
      const on = bits[row + (sx >> 3)]! & (0x80 >> (sx & 7));
      const pxX = left + x;
      if (!on || pxX < 0 || pxX >= c.width) continue;
      const o = (py * c.width + pxX) * 3;
      c.px[o] = color[0];
      c.px[o + 1] = color[1];
      c.px[o + 2] = color[2];
    }
  }
}

/** Integer blend of one channel; a = 0..15 → ×17 maps to 0..255, so a = 15 is exactly `fg`. */
const mix = (bg: number, fg: number, a: number): number =>
  bg + Math.floor(((fg - bg) * a * 17 + 127) / 255);

function blitAlpha(c: Canvas, font: AlphaFont, idx: number, x0: number, y0: number, color: Bgr) {
  const { alpha, boxes, offsets } = fontAlpha(font);
  const scale = font.scale ?? 1;
  const w = boxes[idx * 4 + 2]!;
  const h = boxes[idx * 4 + 3]!;
  if (w === 0 || h === 0) return;
  const gx = (boxes[idx * 4]! << 24) >> 24; // int8
  const left = x0 + gx * scale;
  const top = y0 + boxes[idx * 4 + 1]! * scale;
  const rowBytes = Math.ceil(w / 2);
  for (let y = 0; y < h * scale; y++) {
    const py = top + y;
    if (py < 0 || py >= c.height) continue;
    const row = offsets[idx]! + Math.floor(y / scale) * rowBytes;
    blendRow(c, alpha, row, { left, py, width: w * scale, scale }, color);
  }
}

function blendRow(
  c: Canvas,
  alpha: Uint8Array,
  row: number,
  at: { left: number; py: number; width: number; scale: number },
  color: Bgr,
) {
  for (let x = 0; x < at.width; x++) {
    const pxX = at.left + x;
    if (pxX < 0 || pxX >= c.width) continue;
    const sx = Math.floor(x / at.scale);
    const byte = alpha[row + (sx >> 1)]!;
    const a = sx & 1 ? byte & 0x0f : byte >> 4;
    if (a === 0) continue;
    const o = (at.py * c.width + pxX) * 3;
    c.px[o] = mix(c.px[o]!, color[0], a);
    c.px[o + 1] = mix(c.px[o + 1]!, color[1], a);
    c.px[o + 2] = mix(c.px[o + 2]!, color[2], a);
  }
}

const RING: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

/** Draw every glyph of the layout at `offsets` from its pen (bold smears 1 px right). */
function drawText(
  c: Canvas,
  layout: WidgetLayout,
  offsets: ReadonlyArray<readonly [number, number]>,
  color: Bgr,
) {
  const bold = layout.style.bold === true;
  for (const { chars, font, x, y } of layout.lines) {
    let pen = x;
    for (const ch of chars) {
      const cp = ch.codePointAt(0)!;
      for (const [dx, dy] of offsets) {
        blitGlyph(c, font, cp, pen + dx, y + dy, color);
        if (bold) blitGlyph(c, font, cp, pen + dx + 1, y + dy, color);
      }
      pen += glyphAdvance(font, cp) + (bold ? 1 : 0);
    }
  }
}

/** 24-bit bottom-up BMP of a width×height BGR pixel buffer. */
function encodeBmp({ px, width, height }: Canvas): Uint8Array {
  // 14-byte file header + 40-byte BITMAPINFOHEADER.
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const dataSize = rowSize * height;
  const buf = Buffer.alloc(54 + dataSize);
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10); // pixel data offset
  buf.writeUInt32LE(40, 14); // info header size
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26); // planes
  buf.writeUInt16LE(24, 28); // bpp
  buf.writeUInt32LE(dataSize, 34);
  for (let row = 0; row < height; row++) {
    const srcY = height - 1 - row; // bottom-up
    buf.set(px.subarray(srcY * width * 3, (srcY + 1) * width * 3), 54 + row * rowSize);
  }
  // buf is freshly allocated here and never retained, so a view is safe without a copy.
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
}

/** Draw a layout into an upright width×height 24-bit BMP (the worker transform
 *  accepts any format the image crate sniffs — BMP included). `inverted` swaps the
 *  text and background colours (tap-refresh flash). */
export function composeLayout(
  layout: WidgetLayout,
  width: number,
  height: number,
  inverted = false,
): Uint8Array {
  const { style } = layout;
  const text = bgr(style.color ?? DEFAULT_TEXT_COLOR);
  const back = bgr(style.background ?? DEFAULT_TEXT_BACKGROUND);
  const [bg, fg] = inverted ? [text, back] : [back, text];
  const c: Canvas = { px: new Uint8Array(width * height * 3), width, height };
  for (let o = 0; o < c.px.length; o += 3) {
    c.px[o] = bg[0];
    c.px[o + 1] = bg[1];
    c.px[o + 2] = bg[2];
  }
  // Every outline before any foreground, so a ring never covers a neighbor's glyph.
  if (style.outline) drawText(c, layout, RING, bgr(style.outline));
  drawText(c, layout, [[0, 0]], fg);
  return encodeBmp(c);
}

/** Compose widget lines into a BMP (layout + draw in one call). */
export function composeWidgetBmp(
  lines: readonly WidgetLine[],
  width: number,
  height = width,
  style: ExtraKeyTextStyle = {},
): Uint8Array {
  return composeLayout(layoutWidget(lines, width, height, style), width, height);
}
