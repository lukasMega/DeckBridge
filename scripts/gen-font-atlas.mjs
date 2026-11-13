// Regenerates ts/src/assets/font-atlas.ts (+ font-glyph-index.ts) from three font families:
//   regular — Spleen (BSD 2-Clause, https://github.com/fcambus/spleen), monospace;
//   narrow  — X11 Adobe Helvetica helvR (xorg font-adobe-75dpi, Adobe/DEC notice), proportional;
//   slim    — Barlow Condensed TTF (OFL-1.1), rasterized anti-aliased by ttf.mjs, proportional.
// Run manually when changing fonts/glyph set: node scripts/gen-font-atlas.mjs
// Downloads the BDF/TTF sources (they are not vendored; TTFs are cached in $TMPDIR).
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseBdf } from './bdf.mjs';
import { fetchCached, fitPxForHeight, loadFace, loadOpentype, rasterizeAA } from './ttf.mjs';

const SPLEEN_RAW = 'https://raw.githubusercontent.com/fcambus/spleen/master';
const HELV_RAW = 'https://gitlab.freedesktop.org/xorg/font/adobe-75dpi/-/raw/master';
// Smallest → largest: ladder order, which widget-layout.ts indexes by size step.
const REGULAR = [
  { name: 'FONT_5X8', url: `${SPLEEN_RAW}/spleen-5x8.bdf` },
  { name: 'FONT_6X12', url: `${SPLEEN_RAW}/spleen-6x12.bdf` },
  { name: 'FONT_8X16', url: `${SPLEEN_RAW}/spleen-8x16.bdf` },
  { name: 'FONT_12X24', url: `${SPLEEN_RAW}/spleen-12x24.bdf` },
  { name: 'FONT_16X32', url: `${SPLEEN_RAW}/spleen-16x32.bdf` },
  { name: 'FONT_32X64', url: `${SPLEEN_RAW}/spleen-32x64.bdf` },
];
// One rung per Spleen rung, the largest helvR whose full Latin-1 ink height stays under
// it (the 8 px rung has none: helvR08 is 11 px). 64 has no design size: 24 pt × 2.
const NARROW = [
  { name: 'NARROW_8', url: `${HELV_RAW}/helvR08.bdf` },
  { name: 'NARROW_10', url: `${HELV_RAW}/helvR10.bdf` },
  { name: 'NARROW_12', url: `${HELV_RAW}/helvR12.bdf` },
  { name: 'NARROW_18', url: `${HELV_RAW}/helvR18.bdf` },
  { name: 'NARROW_24', url: `${HELV_RAW}/helvR24.bdf` },
  { name: 'NARROW_24X2', url: `${HELV_RAW}/helvR24.bdf`, scale: 2 },
];
// Barlow Condensed: Regular where thin strokes would wash out (≤ 16 px), Light above.
// The 8 px rung reuses NARROW_8 (a 6 px AA face is unreadable); 64 is the 32 rung ×2.
const BARLOW_RAW = 'https://raw.githubusercontent.com/google/fonts/main/ofl/barlowcondensed';
const SLIM = [
  { name: 'SLIM_12', line: 12, weight: 'Regular' },
  { name: 'SLIM_16', line: 16, weight: 'Regular' },
  { name: 'SLIM_24', line: 24, weight: 'Light' },
  { name: 'SLIM_32', line: 32, weight: 'Light' },
];

// ASCII printable, Latin-1 (U+00A0–U+00FF), then U+2026 (…) — fontGlyphIndex() order.
const CODEPOINTS = [
  ...Array.from({ length: 95 }, (_, i) => 32 + i),
  ...Array.from({ length: 96 }, (_, i) => 0xa0 + i),
  0x2026,
];

/** Glyphs a source font may lack, and how to stand in for them. */
function fillGaps(glyphs, file) {
  // NBSP draws as a space.
  if (!glyphs.has(0xa0) && glyphs.has(32)) glyphs.set(0xa0, glyphs.get(32));
  // Spleen 5x8/6x12 have no '…': three '.' dots with a 1-px gap, as narrow as they go.
  if (!glyphs.has(0x2026)) {
    const dot = glyphs.get(0x2e);
    const ink = [...new Set(dot.rows.flatMap((row) => row.flatMap((on, c) => (on ? [c] : []))))];
    const [c0, c1] = [Math.min(...ink), Math.max(...ink)];
    const dw = c1 - c0 + 1;
    const w = 3 * dw + 2;
    const rows = dot.rows.map((row) =>
      Array.from({ length: w }, (_, c) => c % (dw + 1) < dw && row[c0 + (c % (dw + 1))]),
    );
    if (w > dot.advance) throw new Error(`${file}: synthesized … is wider than a cell`);
    glyphs.set(0x2026, { ...dot, w, x: Math.floor((dot.advance - w) / 2), rows });
  }
  for (const cp of CODEPOINTS) {
    if (!glyphs.has(cp)) throw new Error(`${file}: missing glyph U+${cp.toString(16)}`);
  }
}

/** Lay every glyph into one shared cell: `originX` = cell left edge relative to the pen
 *  (≤ 0 when a glyph overhangs left), `top` = rows above the baseline. */
function cellOf(font, mono) {
  const gl = CODEPOINTS.map((cp) => font.glyphs.get(cp));
  if (mono) {
    const [w, h, fx, fy] = font.fbb;
    return { w, h, originX: fx, top: h + fy };
  }
  const originX = Math.min(0, ...gl.map((g) => g.x));
  const top = Math.max(...gl.map((g) => g.y + g.h));
  const bottom = Math.min(...gl.map((g) => g.y));
  return { w: Math.max(...gl.map((g) => g.x + g.w)) - originX, h: top - bottom, originX, top };
}

/** ASCII ink extent (U+0021..U+007E) in cell rows from the cell top, for tight line packing. */
function inkOfBits(font, cell) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let cp = 0x21; cp <= 0x7e; cp++) {
    const g = font.glyphs.get(cp);
    const y0 = cell.top - (g.y + g.h);
    g.rows.forEach((row, r) => {
      if (!row.some(Boolean)) return;
      lo = Math.min(lo, y0 + r);
      hi = Math.max(hi, y0 + r);
    });
  }
  return { inkTop: lo, inkHeight: hi - lo + 1 };
}

/** Same extent from alpha boxes: rows covered by ink-bearing ASCII glyphs. */
function inkOfBoxes(boxes) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 1; i < 95; i++) {
    const [, top, , h] = boxes.slice(i * 4, i * 4 + 4);
    if (h === 0) continue;
    lo = Math.min(lo, top);
    hi = Math.max(hi, top + h - 1);
  }
  return { inkTop: lo, inkHeight: hi - lo + 1 };
}

/** Pack the codepoints: per glyph ceil(w/8) bytes per row, MSB-first, h rows. */
function packFont(font, cell) {
  const rowBytes = Math.ceil(cell.w / 8);
  const bytes = [];
  for (const cp of CODEPOINTS) {
    const g = font.glyphs.get(cp);
    const bits = Array.from({ length: cell.h }, () => new Array(cell.w).fill(false));
    const y0 = cell.top - (g.y + g.h);
    g.rows.forEach((row, r) =>
      row.forEach((on, c) => {
        const y = y0 + r;
        const x = g.x - cell.originX + c;
        if (on && y >= 0 && y < cell.h && x >= 0 && x < cell.w) bits[y][x] = true;
      }),
    );
    for (const row of bits) {
      for (let b = 0; b < rowBytes; b++) {
        let v = 0;
        for (let bit = 0; bit < 8; bit++) if (row[b * 8 + bit]) v |= 0x80 >> bit;
        bytes.push(v);
      }
    }
  }
  return Buffer.from(bytes);
}

async function load(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

/** Latin-1 string literal (one char per byte). Printable ASCII stays readable, everything else is
 *  an escape, so the generated file is plain ASCII and survives any editor or formatter. */
function latin1Literal(bytes) {
  let out = "'";
  for (const b of Buffer.from(bytes)) {
    if (b === 0x27 || b === 0x5c) out += `\\${String.fromCharCode(b)}`;
    else if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b);
    else out += `\\x${b.toString(16).padStart(2, '0')}`;
  }
  return `${out}'`;
}

async function emit({ name, url, scale = 1 }, mono) {
  const text = await load(url);
  const font = parseBdf(text);
  fillGaps(font.glyphs, url);
  const cell = cellOf(font, mono);
  const ink = inkOfBits(font, cell);
  const fields = [
    `  width: ${cell.w * scale},`,
    `  height: ${cell.h * scale},`,
    `  inkTop: ${ink.inkTop * scale},`,
    `  inkHeight: ${ink.inkHeight * scale},`,
    `  bits:\n    ${latin1Literal(packFont(font, cell))},`,
  ];
  if (!mono) {
    const adv = CODEPOINTS.map((cp) => font.glyphs.get(cp).advance * scale);
    fields.push(`  advances: ${latin1Literal(adv)},`);
    if (cell.originX) fields.push(`  originX: ${cell.originX * scale},`);
  }
  if (scale > 1) fields.push(`  scale: ${scale},`);
  return { text, src: `const ${name}: BitmapFont = {\n${fields.join('\n')}\n};\n` };
}

/** Tight-box 4-bit atlas of one TTF rung. Per glyph: `alpha` = ceil(w/2) bytes per row, high
 *  nibble first, h rows; `boxes` = x (int8, from the pen), top (rows below the cell top), w, h. */
async function emitAlpha({ name, line, weight }, opentype) {
  const url = `${BARLOW_RAW}/BarlowCondensed-${weight}.ttf`;
  const face = loadFace(opentype, await fetchCached(url));
  const px = fitPxForHeight(face, line);
  const raster = new Map(
    CODEPOINTS.map((cp) => [cp, rasterizeAA(face, px, cp, { missing: 'null' })]),
  );
  // NBSP draws as a space.
  if (!raster.get(0xa0)) raster.set(0xa0, raster.get(32));
  for (const [cp, g] of raster) {
    if (!g) throw new Error(`${url}: missing glyph U+${cp.toString(16)}`);
  }
  const glyphs = CODEPOINTS.map((cp) => raster.get(cp));
  const baseline = Math.max(...glyphs.map((g) => g.top));
  const below = Math.max(...glyphs.map((g) => g.h - g.top));
  if (baseline + below > line) throw new Error(`${name}: ink ${baseline + below} > ${line} rows`);
  const alpha = [];
  const boxes = [];
  for (const g of glyphs) {
    boxes.push(g.x & 0xff, baseline - g.top, g.w, g.h);
    const rowBytes = Math.ceil(g.w / 2);
    for (let r = 0; r < g.h; r++) {
      for (let b = 0; b < rowBytes; b++) {
        const hi = g.alpha[r * g.w + b * 2];
        const lo = b * 2 + 1 < g.w ? g.alpha[r * g.w + b * 2 + 1] : 0;
        alpha.push((hi << 4) | lo);
      }
    }
  }
  const adv = glyphs.map((g) => g.advance);
  const width = Math.max(...adv);
  const ink = inkOfBoxes(boxes);
  const src =
    `const ${name}: AlphaFont = {\n  kind: 'alpha',\n  width: ${width},\n  height: ${line},\n` +
    `  inkTop: ${ink.inkTop},\n  inkHeight: ${ink.inkHeight},\n` +
    `  alpha:\n    ${latin1Literal(alpha)},\n` +
    `  boxes: ${latin1Literal(boxes)},\n` +
    `  advances: ${latin1Literal(adv)},\n};\n`;
  return { src, adv, width, ink, alphaBytes: alpha.length };
}

/** Same glyph data as `base`, blitted ×scale (like NARROW_24X2): no second copy of the atlas. */
function emitAlphaScaled(name, base, adv, line, ink, scale) {
  const scaled = adv.map((a) => a * scale);
  if (Math.max(...scaled) > 255) throw new Error(`${name}: advance exceeds one byte`);
  return (
    `const ${name}: AlphaFont = {\n  kind: 'alpha',\n  width: ${Math.max(...scaled)},\n` +
    `  height: ${line * scale},\n  inkTop: ${ink.inkTop * scale},\n  inkHeight: ${ink.inkHeight * scale},\n  alpha: ${base}.alpha,\n  boxes: ${base}.boxes,\n` +
    `  advances: ${latin1Literal(scaled)},\n  scale: ${scale},\n};\n`
  );
}

const parts = [];
let spleenVersion = '';
for (const f of REGULAR) {
  const { text, src } = await emit(f, true);
  spleenVersion ||= /Spleen \S+ ([\d.]+)/.exec(text)?.[1] ?? 'unknown';
  parts.push(src);
}
for (const f of NARROW) parts.push((await emit(f, false)).src);
const opentype = loadOpentype();
let top = null;
for (const f of SLIM) {
  top = await emitAlpha(f, opentype);
  parts.push(top.src);
}
parts.push(emitAlphaScaled('SLIM_32X2', 'SLIM_32', top.adv, SLIM.at(-1).line, top.ink, 2));

const header = `// AUTO-GENERATED by scripts/gen-font-atlas.mjs — DO NOT EDIT
// Regular: Spleen ${spleenVersion} (c) 2018-2026 Frederic Cambus — BSD 2-Clause license.
// https://github.com/fcambus/spleen — license text: see LICENSE-spleen.txt (repo scripts/).
// Narrow: X11 Adobe Helvetica helvR 08/10/12/18/24 (75 dpi; the last rung is 24 scaled ×2).
// Copyright 1984-1989, 1994 Adobe Systems Incorporated.
// Copyright 1988, 1994 Digital Equipment Corporation.
// Permission notice: see LICENSE-helvetica.txt (repo scripts/).
// Slim: Barlow Condensed Light/Regular (c) 2017 The Barlow Project Authors
// (https://github.com/jpt/barlow), SIL Open Font License 1.1, no Reserved Font Name.
// OFL-1.1, license text: see LICENSE-barlow.txt (repo scripts/). Rasterized anti-aliased
// (4-bit coverage) by scripts/ttf.mjs; the 8 px rung reuses NARROW_8, the 64 px rung is 32 ×2.
// U+2026 in Spleen 5x8/6x12 is synthesized from three '.' glyphs; U+00A0 copies space.
// Bits fonts: packed monochrome cells for codepoints 32..126, 0xA0..0xFF, 0x2026, in that
// order: per glyph ceil(cellWidth/8) bytes per row (MSB-first), cell height rows top→bottom,
// cellWidth/height = width/height ÷ scale.
// Alpha fonts: same glyph order, tight per-glyph boxes (see AlphaFont).

// fontGlyphIndex() lives in font-glyph-index.ts: it carries no atlas data, so workers that
// only validate text do not bundle the atlas.

interface FontMetrics {
  /** Cell size in device pixels (after \`scale\`); width = max advance for alpha fonts. */
  readonly width: number;
  readonly height: number;
  /** ASCII (U+0021..U+007E) ink top, rows below the cell top; for tight line packing. */
  readonly inkTop: number;
  /** ASCII ink height in rows (after \`scale\`); tight rows are this tall instead of \`height\`. */
  readonly inkHeight: number;
  /** Latin-1 string, one char (= byte) per glyph: advance width in px. Absent = monospace (= width). */
  readonly advances?: string;
  /** Cell left edge relative to the pen, ≤ 0. Absent = 0. Bits fonts only. */
  readonly originX?: number;
}

/** 1-bit cells. */
export interface BitsFont extends FontMetrics {
  readonly kind?: 'bits';
  /** Latin-1 string (one char per byte) of the packed glyph bitmaps, stored at 1/scale. */
  readonly bits: string;
  /** Nearest-neighbor upscale of the stored bits. Absent = 1. */
  readonly scale?: number;
}

/** Anti-aliased glyphs in tight boxes. Box values are stored at 1/scale like \`bits\`. */
export interface AlphaFont extends FontMetrics {
  readonly kind: 'alpha';
  /** Latin-1 string, 4-bit coverage (0..15), 2 px per byte high nibble first; per glyph h rows of ceil(w/2) bytes. */
  readonly alpha: string;
  /** Latin-1 string, 4 bytes per glyph: x (int8, from the pen), top (rows below the cell top), w, h. */
  readonly boxes: string;
  /** Nearest-neighbor upscale of the stored alpha. Absent = 1. */
  readonly scale?: number;
}

export type BitmapFont = BitsFont | AlphaFont;

`;

const assetsDir = join(dirname(fileURLToPath(import.meta.url)), '../ts/src/assets');
const outPath = join(assetsDir, 'font-atlas.ts');
// Own file: font-atlas.ts is ~250 KB of data that an index-only consumer would pull in.
const indexPath = join(assetsDir, 'font-glyph-index.ts');
const indexSrc = `// AUTO-GENERATED by scripts/gen-font-atlas.mjs — DO NOT EDIT
// Glyph order of every packed atlas in font-atlas.ts: ASCII printable, Latin-1
// (U+00A0–U+00FF), then U+2026 (…).

/** Index of a codepoint in every packed atlas, or -1 if not covered. */
export function fontGlyphIndex(codepoint: number): number {
  if (codepoint >= 32 && codepoint <= 126) return codepoint - 32;
  if (codepoint >= 0xa0 && codepoint <= 0xff) return codepoint - 0xa0 + 95;
  return codepoint === 0x2026 ? ${CODEPOINTS.length - 1} : -1;
}
`;
writeFileSync(indexPath, indexSrc);
const ladder = (doc, name, fonts) =>
  `\n/** ${doc} */\nexport const ${name}: readonly BitmapFont[] = [${fonts.map((f) => f.name).join(', ')}];\n`;
writeFileSync(
  outPath,
  header +
    parts.join('\n') +
    ladder('Spleen sizes, smallest → largest.', 'FONT_LADDER', REGULAR) +
    ladder('Helvetica sizes, one per FONT_LADDER rung.', 'NARROW_LADDER', NARROW) +
    `\n/** Barlow Condensed sizes, one per FONT_LADDER rung. */\nexport const SLIM_LADDER: readonly BitmapFont[] = [NARROW_8, ${[...SLIM.map((f) => f.name), 'SLIM_32X2'].join(', ')}];\n`,
);
console.log(`wrote ${outPath}\nwrote ${indexPath}`);
