// Pure layout + BMP compose for DeckBridge display widgets (side keys, touch-strip
// zones). Shared so the WebUI server can render size previews from the same code
// the widget scheduler (extra-keys.ts) paints the device with.
import { FONT_LADDER, fontGlyphIndex } from './assets/font-atlas.js';
import type { BitmapFont } from './assets/font-atlas.js';
import type { ExtraKeyTextSize, ExtraKeyWrap } from './web/contract.js';

// Key panel colors — match the WebUI's former canvas icons.
const BG = [0x14, 0x10, 0x10] as const; // BGR of #101014
const FG = [0xec, 0xe8, 0xe8] as const; // BGR of #e8e8ec

/** Ladder index of each line role at step 0 — 8×16 and 16×32, the pre-ladder fonts. */
const SMALL_INDEX = 2;
const BIG_INDEX = 4;
/** 'fit' search range: beyond it every role is clamped at a ladder end. */
const FIT_MAX_STEP = FONT_LADDER.length - 1 - SMALL_INDEX;
const FIT_MIN_STEP = -BIG_INDEX;

/** One rendered line of a widget; big = the large role, else the small one. */
export interface WidgetLine {
  text: string;
  big: boolean;
}

interface PlacedLine {
  chars: string[];
  font: BitmapFont;
  x: number;
  y: number;
}

export interface WidgetLayout {
  lines: PlacedLine[];
  /** Some text was cut off (too wide or too many lines for the image). */
  clipped: boolean;
}

/** WebUI mirror of one widget paint (see ExtraKeyWidgets). */
export interface WidgetPaint {
  bmp: Uint8Array;
  lines: readonly WidgetLine[];
  width: number;
  height: number;
  clipped: boolean;
  /** Wrap mode the paint used — size previews re-lay the lines with it. */
  wrap?: ExtraKeyWrap;
  /** Touch-strip zone: only its status and preview data reach the WebUI, not the image. */
  zone: boolean;
}

function fontFor(line: WidgetLine, step: number): BitmapFont {
  const base = line.big ? BIG_INDEX : SMALL_INDEX;
  return FONT_LADDER[Math.min(Math.max(base + step, 0), FONT_LADDER.length - 1)]!;
}

function chunk(chars: string[], max: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < chars.length; i += max) out.push(chars.slice(i, i + max));
  return out;
}

/** Split one line (as code points) into rows of at most `max` characters. */
function wrapChars(chars: string[], max: number, wrap: ExtraKeyWrap): string[][] {
  if (wrap === 'chars') {
    return chunk(chars, max)
      .map((row) => Array.from(row.join('').trim()))
      .filter((row) => row.length > 0);
  }
  const rows: string[][] = [];
  let row: string[] = [];
  for (const word of chars.join('').split(/ +/).filter(Boolean)) {
    const w = Array.from(word);
    if (row.length > 0 && row.length + 1 + w.length <= max) {
      row.push(' ', ...w);
      continue;
    }
    if (row.length > 0) rows.push(row);
    // An over-long word is split mid-word rather than lost.
    const parts = chunk(w, max);
    row = parts.pop() ?? [];
    rows.push(...parts);
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

/** The rows drawn at `step`: each line in its role's font, wrapped to the width if asked. */
function rowsAt(
  lines: readonly WidgetLine[],
  width: number,
  step: number,
  wrap: ExtraKeyWrap | undefined,
): Array<{ chars: string[]; font: BitmapFont }> {
  return lines.flatMap((line) => {
    const font = fontFor(line, step);
    const chars = Array.from(line.text);
    const max = Math.floor(width / font.width);
    if (!wrap || max < 1 || chars.length <= max) return [{ chars, font }];
    return wrapChars(chars, max, wrap).map((row) => ({ chars: row, font }));
  });
}

function fits(
  lines: readonly WidgetLine[],
  width: number,
  height: number,
  step: number,
  wrap: ExtraKeyWrap | undefined,
): boolean {
  let totalH = 0;
  for (const { chars, font } of rowsAt(lines, width, step, wrap)) {
    if (chars.length * font.width > width) return false;
    totalH += font.height;
  }
  return totalH <= height;
}

function resolveStep(
  lines: readonly WidgetLine[],
  width: number,
  height: number,
  textSize: ExtraKeyTextSize,
  wrap: ExtraKeyWrap | undefined,
): number {
  if (textSize !== 'fit') return textSize;
  for (let step = FIT_MAX_STEP; step > FIT_MIN_STEP; step--) {
    if (fits(lines, width, height, step, wrap)) return step;
  }
  return FIT_MIN_STEP;
}

/** Where each row goes at `textSize`: rows stacked and centred, each truncated to the
 *  width — after wrapping long lines into rows when `wrap` is set. */
export function layoutWidget(
  lines: readonly WidgetLine[],
  width: number,
  height: number,
  textSize: ExtraKeyTextSize = 0,
  wrap?: ExtraKeyWrap,
): WidgetLayout {
  const step = resolveStep(lines, width, height, textSize, wrap);
  const rows = rowsAt(lines, width, step, wrap);
  const totalH = rows.reduce((h, row) => h + row.font.height, 0);
  let clipped = totalH > height;
  let y = Math.max(0, Math.floor((height - totalH) / 2));
  const placed = rows.map(({ chars: all, font }) => {
    const chars = all.slice(0, Math.floor(width / font.width));
    if (chars.length < all.length) clipped = true;
    const x = Math.floor((width - chars.length * font.width) / 2);
    const out = { chars, font, x, y };
    y += font.height;
    return out;
  });
  return { lines: placed, clipped };
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

/** Blit one glyph (foreground pixels only) into a width×height BGR pixel buffer. */
function blitGlyph(
  px: Uint8Array,
  width: number,
  height: number,
  font: BitmapFont,
  codepoint: number,
  x0: number,
  y0: number,
  fg: readonly number[],
): void {
  const idx = fontGlyphIndex(codepoint);
  if (idx < 0) return;
  const rowBytes = Math.ceil(font.width / 8);
  const bits = fontBits(font);
  const base = idx * rowBytes * font.height;
  for (let y = 0; y < font.height; y++) {
    const py = y0 + y;
    if (py < 0 || py >= height) continue;
    for (let x = 0; x < font.width; x++) {
      const on = bits[base + y * rowBytes + (x >> 3)]! & (0x80 >> (x & 7));
      const pxX = x0 + x;
      if (!on || pxX < 0 || pxX >= width) continue;
      const o = (py * width + pxX) * 3;
      px[o] = fg[0]!;
      px[o + 1] = fg[1]!;
      px[o + 2] = fg[2]!;
    }
  }
}

/** Draw a layout into an upright width×height 24-bit BMP (the worker transform
 *  accepts any format the image crate sniffs — BMP included). `inverted` swaps the
 *  panel colours (tap-refresh flash). */
export function composeLayout(
  layout: WidgetLayout,
  width: number,
  height: number,
  inverted = false,
): Uint8Array {
  const [bg, fg] = inverted ? [FG, BG] : [BG, FG];
  const px = new Uint8Array(width * height * 3);
  for (let o = 0; o < px.length; o += 3) {
    px[o] = bg[0];
    px[o + 1] = bg[1];
    px[o + 2] = bg[2];
  }
  for (const { chars, font, x, y } of layout.lines) {
    chars.forEach((ch, i) => {
      blitGlyph(px, width, height, font, ch.codePointAt(0)!, x + i * font.width, y, fg);
    });
  }

  // 24-bit bottom-up BMP: 14-byte file header + 40-byte BITMAPINFOHEADER.
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

/** Compose widget lines into a BMP at `textSize` (layout + draw in one call). */
export function composeWidgetBmp(
  lines: readonly WidgetLine[],
  width: number,
  height = width,
  textSize: ExtraKeyTextSize = 0,
  wrap?: ExtraKeyWrap,
): Uint8Array {
  return composeLayout(layoutWidget(lines, width, height, textSize, wrap), width, height);
}
