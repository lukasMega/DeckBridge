// Draws a widget layout (widget-layout.ts) into a 24-bit BMP: colours, bold, outline.
import { fontGlyphIndex } from './assets/font-atlas.js';
import type { BitmapFont } from './assets/font-atlas.js';
import { DEFAULT_TEXT_BACKGROUND, DEFAULT_TEXT_COLOR } from './extra-key-config.js';
import type { ExtraKeyTextStyle } from './web/contract.js';
import { glyphAdvance, layoutWidget, type WidgetLayout, type WidgetLine } from './widget-layout.js';

type Bgr = readonly [number, number, number];

/** '#rrggbb' → BMP byte order. */
function bgr(hex: string): Bgr {
  const n = Number.parseInt(hex.slice(1), 16);
  return [n & 0xff, (n >> 8) & 0xff, n >> 16];
}

const decodedFonts = new Map<BitmapFont, Uint8Array>();
function fontBits(font: BitmapFont): Uint8Array {
  let bits = decodedFonts.get(font);
  if (!bits) {
    bits = new Uint8Array(Buffer.from(font.bits, 'base64'));
    decodedFonts.set(font, bits);
  }
  return bits;
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
  return new Uint8Array(buf);
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
