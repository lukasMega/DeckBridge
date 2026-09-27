// Regenerates ts/src/assets/font-atlas.ts from two bitmap font families:
//   regular — Spleen (BSD 2-Clause, https://github.com/fcambus/spleen), monospace;
//   narrow  — X11 Adobe Helvetica helvR (xorg font-adobe-75dpi, Adobe/DEC notice), proportional.
// Run manually when changing fonts/glyph set: node scripts/gen-font-atlas.mjs
// Downloads the BDF sources (they are not vendored).
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseBdf } from './bdf.mjs';

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
    if (w > dot.advance) throw new Error(`${file}: synthesised … is wider than a cell`);
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
  return Buffer.from(bytes).toString('base64');
}

async function load(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

const wrapB64 = (b64) => `'${b64}'`;

async function emit({ name, url, scale = 1 }, mono) {
  const text = await load(url);
  const font = parseBdf(text);
  fillGaps(font.glyphs, url);
  const cell = cellOf(font, mono);
  const fields = [
    `  width: ${cell.w * scale},`,
    `  height: ${cell.h * scale},`,
    `  bits:\n    ${wrapB64(packFont(font, cell))},`,
  ];
  if (!mono) {
    const adv = CODEPOINTS.map((cp) => font.glyphs.get(cp).advance * scale);
    fields.push(`  advances: ${wrapB64(Buffer.from(adv).toString('base64'))},`);
    if (cell.originX) fields.push(`  originX: ${cell.originX * scale},`);
  }
  if (scale > 1) fields.push(`  scale: ${scale},`);
  return { text, src: `const ${name}: BitmapFont = {\n${fields.join('\n')}\n};\n` };
}

const parts = [];
let spleenVersion = '';
for (const f of REGULAR) {
  const { text, src } = await emit(f, true);
  spleenVersion ||= /Spleen \S+ ([\d.]+)/.exec(text)?.[1] ?? 'unknown';
  parts.push(src);
}
for (const f of NARROW) parts.push((await emit(f, false)).src);

const header = `// AUTO-GENERATED by scripts/gen-font-atlas.mjs — DO NOT EDIT
// Regular: Spleen ${spleenVersion} (c) 2018-2026 Frederic Cambus — BSD 2-Clause license.
// https://github.com/fcambus/spleen — license text: see LICENSE-spleen.txt (repo scripts/).
// Narrow: X11 Adobe Helvetica helvR 08/10/12/18/24 (75 dpi; the last rung is 24 scaled ×2).
// Copyright 1984-1989, 1994 Adobe Systems Incorporated.
// Copyright 1988, 1994 Digital Equipment Corporation.
// Permission notice: see LICENSE-helvetica.txt (repo scripts/).
// U+2026 in Spleen 5x8/6x12 is synthesised from three '.' glyphs; U+00A0 copies space.
// Packed monochrome cells for codepoints 32..126, 0xA0..0xFF, 0x2026, in that order:
// per glyph ceil(cellWidth/8) bytes per row (MSB-first), cell height rows top→bottom,
// cellWidth/height = width/height ÷ scale.

/** Index of a codepoint in every packed atlas, or -1 if not covered. */
export function fontGlyphIndex(codepoint: number): number {
  if (codepoint >= 32 && codepoint <= 126) return codepoint - 32;
  if (codepoint >= 0xa0 && codepoint <= 0xff) return codepoint - 0xa0 + 95;
  return codepoint === 0x2026 ? ${CODEPOINTS.length - 1} : -1;
}

export interface BitmapFont {
  /** Cell size in device pixels (after \`scale\`). */
  readonly width: number;
  readonly height: number;
  /** base64 of the packed glyph bitmaps, stored at 1/scale. */
  readonly bits: string;
  /** base64, one byte per glyph: advance width in px. Absent = monospace (= width). */
  readonly advances?: string;
  /** Cell left edge relative to the pen, ≤ 0. Absent = 0. */
  readonly originX?: number;
  /** Nearest-neighbour upscale of the stored bits. Absent = 1. */
  readonly scale?: number;
}

`;

const outPath = join(dirname(fileURLToPath(import.meta.url)), '../ts/src/assets/font-atlas.ts');
const ladder = (doc, name, fonts) =>
  `\n/** ${doc} */\nexport const ${name}: readonly BitmapFont[] = [${fonts.map((f) => f.name).join(', ')}];\n`;
writeFileSync(
  outPath,
  header +
    parts.join('\n') +
    ladder('Spleen sizes, smallest → largest.', 'FONT_LADDER', REGULAR) +
    ladder('Helvetica sizes, one per FONT_LADDER rung.', 'NARROW_LADDER', NARROW),
);
console.log(`wrote ${outPath}`);
