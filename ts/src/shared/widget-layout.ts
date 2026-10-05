// Pure text layout for DeckBridge display widgets (side keys, touch-strip zones), in
// pixels so the proportional Narrow font works. Shared so the WebUI server renders
// size previews with the code the widget scheduler (extra-keys.ts) paints with.
import { FONT_LADDER, NARROW_LADDER, SLIM_LADDER, fontGlyphIndex } from '../assets/font-atlas.js';
import type { BitmapFont } from '../assets/font-atlas.js';
import type { ExtraKeyTextStyle, ExtraKeyWrap } from '../web/contract.js';

/** Ladder index of each line role at step 0 — 8×16 and 16×32, the pre-ladder fonts. */
const SMALL_INDEX = 2;
const BIG_INDEX = 4;
/** 'fit' search range: beyond it every role is clamped at a ladder end. */
const FIT_MAX_STEP = FONT_LADDER.length - 1 - SMALL_INDEX;
const FIT_MIN_STEP = -BIG_INDEX;
const ELLIPSIS = '…';

/** One rendered line of a widget; big = the large role, else the small one. */
export interface WidgetLine {
  text: string;
  big: boolean;
}

export interface PlacedLine {
  chars: string[];
  font: BitmapFont;
  /** Pen position of the first glyph (cell top-left, before the font's originX). */
  x: number;
  y: number;
}

export interface WidgetLayout {
  lines: PlacedLine[];
  /** Some text was cut off (too wide or too many lines for the image). */
  clipped: boolean;
  /** The style laid out with — the raster reads colours, bold and outline from it. */
  style: ExtraKeyTextStyle;
}

/** WebUI mirror of one widget paint (see ExtraKeyWidgets). */
export interface WidgetPaint {
  bmp: Uint8Array;
  lines: readonly WidgetLine[];
  width: number;
  height: number;
  clipped: boolean;
  /** Style the paint used — size previews re-lay the lines with it. */
  style: ExtraKeyTextStyle;
  /** Touch-strip zone: only its status and preview data reach the WebUI, not the image. */
  zone: boolean;
}

interface Row {
  chars: string[];
  font: BitmapFont;
}

/** Everything a measurement needs besides the font. */
interface Metrics {
  bold: boolean;
  /** 1-px outline ring: every row grows by 2 px each way. */
  ring: number;
  /** Rows are as tall as the ASCII ink, not the full line height. */
  tight: boolean;
}

const decodedAdvances = new Map<BitmapFont, Uint8Array>();

/** Advance width of one glyph in px; monospace fonts and unknown glyphs use the cell width. */
export function glyphAdvance(font: BitmapFont, codepoint: number): number {
  if (!font.advances) return font.width;
  let adv = decodedAdvances.get(font);
  if (!adv) {
    adv = new Uint8Array(Buffer.from(font.advances, 'base64'));
    decodedAdvances.set(font, adv);
  }
  const idx = fontGlyphIndex(codepoint);
  return idx < 0 ? font.width : adv[idx]!;
}

/** Drawn width of a row: advances, +1 px per glyph when bold. */
export function textWidth(font: BitmapFont, chars: readonly string[], bold = false): number {
  let w = 0;
  for (const ch of chars) w += glyphAdvance(font, ch.codePointAt(0)!) + (bold ? 1 : 0);
  return w;
}

const rowWidth = (row: Row, m: Metrics): number =>
  textWidth(row.font, row.chars, m.bold) + 2 * m.ring;

function ladderFor(style: ExtraKeyTextStyle): readonly BitmapFont[] {
  if (style.font === 'narrow') return NARROW_LADDER;
  return style.font === 'slim' ? SLIM_LADDER : FONT_LADDER;
}

function fontFor(ladder: readonly BitmapFont[], line: WidgetLine, step: number): BitmapFont {
  const base = line.big ? BIG_INDEX : SMALL_INDEX;
  return ladder[Math.min(Math.max(base + step, 0), ladder.length - 1)]!;
}

/** Longest prefix of `chars` no wider than `max` px (at least nothing). */
function prefixFitting(font: BitmapFont, chars: string[], max: number, m: Metrics): number {
  let w = 2 * m.ring;
  for (let i = 0; i < chars.length; i++) {
    w += glyphAdvance(font, chars[i]!.codePointAt(0)!) + (m.bold ? 1 : 0);
    if (w > max) return i;
  }
  return chars.length;
}

/** Split `chars` into chunks no wider than `max` px, each at least one character. */
function chunk(font: BitmapFont, chars: string[], max: number, m: Metrics): string[][] {
  const out: string[][] = [];
  let rest = chars;
  while (rest.length > 0) {
    const n = Math.max(1, prefixFitting(font, rest, max, m));
    out.push(rest.slice(0, n));
    rest = rest.slice(n);
  }
  return out;
}

/** Split one line (as code points) into rows no wider than `max` px. */
function wrapChars(
  font: BitmapFont,
  chars: string[],
  max: number,
  wrap: ExtraKeyWrap,
  m: Metrics,
): string[][] {
  if (wrap === 'chars') {
    return chunk(font, chars, max, m)
      .map((row) => Array.from(row.join('').trim()))
      .filter((row) => row.length > 0);
  }
  const fitsRow = (row: string[]): boolean => rowWidth({ chars: row, font }, m) <= max;
  const rows: string[][] = [];
  let row: string[] = [];
  for (const word of chars.join('').split(/ +/).filter(Boolean)) {
    const w = Array.from(word);
    if (row.length > 0 && fitsRow([...row, ' ', ...w])) {
      row.push(' ', ...w);
      continue;
    }
    if (row.length > 0) rows.push(row);
    // An over-long word is split mid-word rather than lost.
    const parts = chunk(font, w, max, m);
    row = parts.pop() ?? [];
    rows.push(...parts);
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

/** The rows drawn at `step`: each line in its role's font, wrapped to the width if asked. */
function rowsAt(
  lines: readonly WidgetLine[],
  boxW: number,
  step: number,
  style: ExtraKeyTextStyle,
  m: Metrics,
): Row[] {
  const ladder = ladderFor(style);
  return lines.flatMap((line) => {
    const font = fontFor(ladder, line, step);
    const chars = Array.from(line.text);
    const row = { chars, font };
    // No wrap when not even one character fits: nothing to gain.
    if (!style.wrap || rowWidth(row, m) <= boxW || prefixFitting(font, chars, boxW, m) < 1) {
      return [row];
    }
    return wrapChars(font, chars, boxW, style.wrap, m).map((r) => ({ chars: r, font }));
  });
}

/** Distance from a row's top to the next row's top, ring included. A negative gap lets
 *  rows overlap, but never below 1 px so the block keeps a positive height. */
const rowPitch = (font: BitmapFont, gap: number, m: Metrics): number =>
  Math.max(1, (m.tight ? font.inkHeight : font.height) + 2 * m.ring + gap);

function blockHeight(rows: readonly Row[], lineGap: number, m: Metrics): number {
  const last = rows.at(-1);
  if (!last) return 0;
  // The last row has no gap after it, so it keeps its own full height.
  const lastH = rowPitch(last.font, 0, m);
  return rows.slice(0, -1).reduce((h, row) => h + rowPitch(row.font, lineGap, m), lastH);
}

function fits(rows: readonly Row[], boxW: number, boxH: number, lineGap: number, m: Metrics) {
  return rows.every((row) => rowWidth(row, m) <= boxW) && blockHeight(rows, lineGap, m) <= boxH;
}

function resolveStep(
  lines: readonly WidgetLine[],
  boxW: number,
  boxH: number,
  style: ExtraKeyTextStyle,
  m: Metrics,
): number {
  const size = style.textSize ?? 0;
  if (size !== 'fit') return size;
  const gap = style.lineGap ?? 0;
  for (let step = FIT_MAX_STEP; step > FIT_MIN_STEP; step--) {
    if (fits(rowsAt(lines, boxW, step, style, m), boxW, boxH, gap, m)) return step;
  }
  return FIT_MIN_STEP;
}

/** Cut a row to `boxW`; with `ellipsis`, end the cut row with '…'. */
function truncate(row: Row, boxW: number, ellipsis: boolean, m: Metrics) {
  const n = prefixFitting(row.font, row.chars, boxW, m);
  const kept = row.chars.slice(0, n);
  if (n === row.chars.length || !ellipsis) return { chars: kept, cut: n < row.chars.length };
  const withEllipsis = (): Row => ({ chars: [...kept, ELLIPSIS], font: row.font });
  while (kept.length > 0 && rowWidth(withEllipsis(), m) > boxW) kept.pop();
  while (kept.at(-1) === ' ') kept.pop();
  // A lone '…' hides all content: keep the plain cut instead.
  if (kept.length === 0) return { chars: row.chars.slice(0, n), cut: true };
  return { chars: withEllipsis().chars, cut: true };
}

function alignedX(align: ExtraKeyTextStyle['align'], pad: number, boxW: number, w: number) {
  if (align === 'left') return pad;
  if (align === 'right') return pad + boxW - w;
  return pad + Math.floor((boxW - w) / 2);
}

function blockTop(valign: ExtraKeyTextStyle['valign'], pad: number, boxH: number, h: number) {
  // An overflowing block starts at the top edge, whatever the alignment.
  const free = Math.max(0, boxH - h);
  if (valign === 'top') return pad;
  if (valign === 'bottom') return pad + free;
  return pad + Math.floor(free / 2);
}

/** Where each row goes: rows stacked and aligned inside the padded box, each cut to its
 *  width — after wrapping long lines into rows when `style.wrap` is set. */
export function layoutWidget(
  lines: readonly WidgetLine[],
  width: number,
  height: number,
  style: ExtraKeyTextStyle = {},
): WidgetLayout {
  const m: Metrics = {
    bold: style.bold === true,
    ring: style.outline ? 1 : 0,
    tight: style.tightLines === true,
  };
  const pad = style.padding ?? 0;
  const gap = style.lineGap ?? 0;
  const boxW = Math.max(0, width - 2 * pad);
  const boxH = Math.max(0, height - 2 * pad);
  const step = resolveStep(lines, boxW, boxH, style, m);
  const rows = rowsAt(lines, boxW, step, style, m);
  const totalH = blockHeight(rows, gap, m);
  let clipped = totalH > boxH;
  let y = blockTop(style.valign, pad, boxH, totalH);
  const placed = rows.map((row) => {
    const { chars, cut } = truncate(row, boxW, style.ellipsis !== false, m);
    if (cut) clipped = true;
    const x = alignedX(style.align, pad, boxW, rowWidth({ chars, font: row.font }, m));
    // Draw so the ink, not the cell, starts at the packed row top.
    const inkShift = m.tight ? row.font.inkTop : 0;
    const out = { chars, font: row.font, x: x + m.ring, y: y + m.ring - inkShift };
    y += rowPitch(row.font, gap, m);
    return out;
  });
  return { lines: placed, clipped, style };
}

/** A copy of `layout` with every line moved by (dx, dy) px; pure. */
export function shiftLayout(layout: WidgetLayout, dx: number, dy: number): WidgetLayout {
  return { ...layout, lines: layout.lines.map((l) => ({ ...l, x: l.x + dx, y: l.y + dy })) };
}
