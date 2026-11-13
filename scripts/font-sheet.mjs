// Dev-only contact sheet for the narrow-font spike (plan 2026-09-26_widget-text-rendering):
// downloads each candidate font, renders sample strings at every design size and writes
// one HTML page with coverage + width stats. Never bundled.
//   node scripts/font-sheet.mjs [out.html]      (default: $TMPDIR/deckbridge-font-sheet/sheet.html)
//   node scripts/font-sheet.mjs --slim [out.html]  AA slim-font spike (plan 2026-10-05_slim-widget-font),
//                                                  default: $TMPDIR/deckbridge-font-sheet/slim-sheet.html
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBdf } from './bdf.mjs';
import { CACHE, fetchCached, inside, loadOpentype } from './ttf.mjs';

const SLIM = process.argv[2] === '--slim';
const OUT =
  process.argv.slice(2).find((a) => !a.startsWith('--')) ??
  join(CACHE, SLIM ? 'slim-sheet.html' : 'sheet.html');
const ARK = 'https://github.com/TakWolf/ark-pixel-font/releases/download';
const XORG = 'https://gitlab.freedesktop.org/xorg/font';
const PIXOP = 'https://raw.githubusercontent.com/bauripalash/ttf-pixeloperator-fork/master/ttf';
const SPLEEN = 'https://raw.githubusercontent.com/fcambus/spleen/master';

const SAMPLES = [
  'The quick brown fox',
  '23:59',
  'Příliš žluťoučký kůň',
  'Grüße, Ça va? ½ °C',
  'iiiiii mmmmmm',
];
const MEASURE = 'The quick brown fox jumps over the lazy dog';
const KEYS = [85, 112];
const LATIN1 = Array.from({ length: 0x60 }, (_, i) => 0xa0 + i);

const helv = (dpi, pt) => ({
  label: `helvR${pt} @${dpi}dpi`,
  kind: 'bdf',
  url: `${XORG}/adobe-${dpi}dpi/-/raw/master/helvR${pt}.bdf`,
});
const CANDIDATES = [
  {
    family: 'Spleen (current, monospace reference)',
    license: 'BSD-2-Clause',
    sizes: ['5x8', '6x12', '8x16', '12x24'].map((s) => ({
      label: s,
      kind: 'bdf',
      url: `${SPLEEN}/spleen-${s}.bdf`,
    })),
  },
  {
    family: 'Ark Pixel proportional (latin)',
    license: 'OFL-1.1 (was MIT before 2024)',
    sizes: [
      ['10', '2026.09.25'],
      ['12', '2026.09.25'],
      ['16', '2026.09.01'],
    ].map(([px, tag]) => ({
      label: `${px}px`,
      kind: 'zip',
      url: `${ARK}/${tag}/ark-pixel-font-${px}px-proportional-bdf-v${tag}.zip`,
      member: `ark-pixel-${px}px-proportional-latin.bdf`,
    })),
  },
  {
    family: 'X11 Adobe Helvetica (helvR)',
    license: 'Adobe/DEC permissive notice (must travel with copies)',
    sizes: [
      ...['08', '10', '12', '14', '18', '24'].map((pt) => helv(75, pt)),
      ...['08', '10', '12', '14'].map((pt) => helv(100, pt)),
    ],
  },
  {
    family: 'Pixel Operator (TTF, rasterized)',
    license: 'CC0-1.0',
    sizes: [
      { label: '8px', kind: 'ttf', url: `${PIXOP}/PixelOperator8.ttf`, px: 8 },
      { label: '16px', kind: 'ttf', url: `${PIXOP}/PixelOperator.ttf`, px: 16 },
    ],
  },
];

/** Rasterize a pixel TTF at its design size by sampling pixel centres — exact for
 *  pixel fonts, whose outlines are axis-aligned squares on the pixel grid. */
function ttfFont(opentype, file, px) {
  const buf = readFileSync(file);
  const face = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  const scale = px / face.unitsPerEm;
  const ascent = Math.round(face.ascender * scale);
  const descent = Math.round(-face.descender * scale);
  const glyphs = new Map();
  for (const cp of [...Array.from({ length: 95 }, (_, i) => 32 + i), ...LATIN1, 0x2026]) {
    const g = face.charToGlyph(String.fromCodePoint(cp));
    if (!g || g.index === 0) continue;
    const contours = [];
    let cur = [];
    for (const c of g.getPath(0, 0, px).commands) {
      if (c.type === 'M') cur = [[c.x, c.y]];
      else if (c.type === 'Z') contours.push(cur);
      else cur.push([c.x, c.y]); // L (Q/C endpoints only — pixel fonts have none)
    }
    const top = -ascent;
    const h = ascent + descent;
    const w = Math.max(1, Math.round(g.advanceWidth * scale) + 2);
    const rows = Array.from({ length: h }, (_, r) =>
      Array.from({ length: w }, (_, c) => inside(contours, c - 1 + 0.5, top + r + 0.5)),
    );
    glyphs.set(cp, { advance: Math.round(g.advanceWidth * scale), w, h, x: -1, y: -descent, rows });
  }
  return { ascent, descent, pixelSize: px, glyphs };
}

async function loadSize(size, opentype) {
  const file = await fetchCached(size.url);
  if (size.kind === 'bdf') return parseBdf(readFileSync(file, 'latin1'));
  if (size.kind === 'zip') {
    const text = execFileSync('unzip', ['-p', file, size.member], { maxBuffer: 1 << 28 });
    return parseBdf(text.toString('latin1'));
  }
  return ttfFont(opentype, file, size.px);
}

const advanceOf = (font, cp) => font.glyphs.get(cp)?.advance ?? 0;
const textWidth = (font, s) => [...s].reduce((w, ch) => w + advanceOf(font, ch.codePointAt(0)), 0);

/** Render one string; missing glyphs show as a hollow box. */
function renderText(font, s) {
  const h = font.ascent + font.descent;
  const w = Math.max(1, textWidth(font, s) + 2);
  const px = Array.from({ length: h }, () => new Uint8Array(w));
  let pen = 1;
  for (const ch of s) {
    const g = font.glyphs.get(ch.codePointAt(0));
    if (!g) {
      const bw = Math.max(3, Math.round(h / 3));
      for (let y = 2; y < h - 2; y++) {
        for (let x = 0; x < bw; x++) {
          if (y === 2 || y === h - 3 || x === 0 || x === bw - 1) px[y][pen + x] = 2;
        }
      }
      pen += bw + 1;
      continue;
    }
    const top = font.ascent - (g.y + g.h);
    g.rows.forEach((row, r) =>
      row.forEach((on, c) => {
        const y = top + r;
        const x = pen + g.x + c;
        if (on && y >= 0 && y < h && x >= 0 && x < w) px[y][x] = 1;
      }),
    );
    pen += g.advance;
  }
  return px;
}

/** Rows of 0/1/2 (bg/fg/missing) → 24-bit BMP data URL. */
function bmpUrl(rows) {
  const h = rows.length;
  const w = rows[0].length;
  const rowSize = Math.ceil((w * 3) / 4) * 4;
  const buf = Buffer.alloc(54 + rowSize * h);
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  const colours = [
    [0x14, 0x10, 0x10],
    [0xec, 0xe8, 0xe8],
    [0x3a, 0x45, 0xff],
  ];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      buf.set(colours[rows[h - 1 - y][x]], 54 + y * rowSize + x * 3);
    }
  }
  return `data:image/bmp;base64,${buf.toString('base64')}`;
}

function stats(font) {
  const missing = LATIN1.filter((cp) => !font.glyphs.has(cp));
  const lineH = font.ascent + font.descent;
  const mean = textWidth(font, MEASURE) / MEASURE.length;
  return {
    lineH,
    mean: mean.toFixed(2),
    ratio: (mean / lineH).toFixed(2),
    fit: KEYS.map((k) => Math.floor(k / mean)),
    missing: missing.map((cp) =>
      String.fromCodePoint(cp).replace('\xa0', 'NBSP').replace('\xad', 'SHY'),
    ),
    ellipsis: font.glyphs.has(0x2026),
  };
}

async function writeSheet() {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  let opentype;
  const sections = [];
  const summary = [];
  for (const cand of CANDIDATES) {
    const blocks = [];
    for (const size of cand.sizes) {
      if (size.kind === 'ttf') opentype ??= loadOpentype();
      const font = await loadSize(size, opentype);
      const s = stats(font);
      summary.push({ font: `${cand.family.split(' (')[0]} ${size.label}`, ...s });
      const imgs = SAMPLES.map((t) => {
        const rows = renderText(font, t);
        return `<img src="${bmpUrl(rows)}" style="width:${rows[0].length * 4}px" alt="${esc(t)}">`;
      }).join('<br>');
      blocks.push(
        `<h3>${esc(size.label)} — line ${s.lineH}px, mean advance ${s.mean}px ` +
          `(×${s.ratio} of height), ${s.fit[0]} chars @85px, ${s.fit[1]} chars @112px, ` +
          `U+2026 ${s.ellipsis ? 'yes' : 'NO'}, Latin-1 missing: ${s.missing.length ? esc(s.missing.join(' ')) : 'none'}</h3>${imgs}`,
      );
    }
    sections.push(`<h2>${esc(cand.family)} — ${esc(cand.license)}</h2>${blocks.join('\n')}`);
  }

  writeFileSync(
    OUT,
    `<!doctype html><meta charset="utf-8"><title>DeckBridge font spike</title>
  <style>body{background:#222;color:#ddd;font:13px system-ui;margin:24px}
  img{image-rendering:pixelated;margin:4px 0}h3{font-weight:500;margin:18px 0 4px}</style>
  <p>Samples scaled ×4. Red boxes = glyph missing from the font. Mean advance over
  "${MEASURE}".</p>${sections.join('\n')}`,
  );
  console.table(
    summary.map(({ missing, fit, ...r }) => ({
      ...r,
      fit85: fit[0],
      fit112: fit[1],
      latin1Missing: missing.length,
    })),
  );
  console.log(`wrote ${OUT}`);
}

if (SLIM) {
  const { writeSlimSheet } = await import('./font-sheet-slim.mjs');
  await writeSlimSheet(OUT, { samples: SAMPLES, measure: MEASURE });
} else {
  await writeSheet();
}
