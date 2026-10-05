// Slim-font spike sheet (plan 2026-10-05_slim-widget-font, phase 1), run via
// `node scripts/font-sheet.mjs --slim`. Dev-only, never bundled: rasterizes each candidate
// TTF with ttf.mjs at every ladder rung and writes one HTML page of real pixels + stats.
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { parseBdf } from './bdf.mjs';
import {
  ATLAS_CODEPOINTS,
  fetchCached,
  fitPxForHeight,
  loadFace,
  loadOpentype,
  rasterizeAA,
} from './ttf.mjs';

const RUNGS = [8, 12, 16, 24, 32, 64];
const KEY = [72, 72];
// AKP05/AKP05E touch-strip slot window (devices/ajazz/akp05e.ts TOUCH_SLOT_IMAGE).
const STRIP = [176, 112];
const GF = 'https://raw.githubusercontent.com/google/fonts/main/ofl';
const XORG = 'https://gitlab.freedesktop.org/xorg/font';
const SPLEEN = 'https://raw.githubusercontent.com/fcambus/spleen/master';
const EXTRA_SAMPLES = ['12:34', 'CPU 87%', 'Bohemian Rhapsody - Queen'];
const TILE_TEXT = ['12:34', 'CPU 87%', 'Bohemian Rhapsody - Queen', 'The quick brown fox'];
const WEIGHTS = ['Light', 'Regular'];

const family = (name, dir, file) => ({
  name,
  ofl: `${GF}/${dir}/OFL.txt`,
  files: Object.fromEntries(WEIGHTS.map((w) => [w, `${GF}/${dir}/${file}-${w}.ttf`])),
});
const CANDIDATES = [
  family('Barlow Condensed', 'barlowcondensed', 'BarlowCondensed'),
  family('Fira Sans Condensed', 'firasanscondensed', 'FiraSansCondensed'),
  // Not in IBM/plex's release zip as loose TTFs; google/fonts carries the same static files.
  family('IBM Plex Sans Condensed', 'ibmplexsanscondensed', 'IBMPlexSansCondensed'),
  family('Saira Condensed', 'sairacondensed', 'SairaCondensed'),
];
const NARROW = [
  ['08', 1],
  ['10', 1],
  ['12', 1],
  ['18', 1],
  ['24', 1],
  ['24', 2],
].map(([pt, scale]) => ({
  url: `${XORG}/adobe-75dpi/-/raw/master/helvR${pt}.bdf`,
  scale,
  label: `Narrow helvR${pt}${scale > 1 ? ` ×${scale}` : ''}`,
}));
const REGULAR = ['5x8', '6x12', '8x16', '12x24', '16x32', '32x64'].map((s) => ({
  url: `${SPLEEN}/spleen-${s}.bdf`,
  scale: 1,
  mono: true,
  label: `Regular Spleen ${s}`,
}));

/** Glyph map { advance, x, top, w, h, alpha 0..15 } + line metrics, whatever the source. */
function finishFont(label, glyphs) {
  const set = [...glyphs.values()].filter((g) => g.w > 0);
  const ascent = Math.max(...set.map((g) => g.top));
  const descent = Math.max(0, ...set.map((g) => g.h - g.top));
  return { label, glyphs, ascent, lineH: ascent + descent };
}

function fromBdf(src, bdf) {
  const s = src.scale;
  const glyphs = new Map();
  for (const cp of ATLAS_CODEPOINTS) {
    const g = bdf.glyphs.get(cp);
    if (!g) continue;
    const alpha = new Uint8Array(g.w * s * g.h * s);
    g.rows.forEach((row, r) =>
      row.forEach((on, c) => {
        for (let dy = 0; dy < s; dy++)
          for (let dx = 0; dx < s; dx++) {
            if (on) alpha[(r * s + dy) * g.w * s + c * s + dx] = 15;
          }
      }),
    );
    glyphs.set(cp, {
      advance: g.advance * s,
      x: g.x * s,
      top: (g.y + g.h) * s,
      w: g.w * s,
      h: g.h * s,
      alpha,
    });
  }
  const font = finishFont(src.label, glyphs);
  // Today's 1-bit atlas: one shared cell per glyph, ceil(w/8) bytes per row.
  const gl = ATLAS_CODEPOINTS.flatMap((cp) => bdf.glyphs.get(cp) ?? []);
  const originX = Math.min(0, ...gl.map((g) => g.x));
  const cellW = src.mono ? bdf.fbb[0] : Math.max(...gl.map((g) => g.x + g.w)) - originX;
  const cellH = src.mono
    ? bdf.fbb[1]
    : Math.max(...gl.map((g) => g.y + g.h)) - Math.min(...gl.map((g) => g.y));
  const bytes =
    Math.ceil(cellW / 8) * cellH * ATLAS_CODEPOINTS.length +
    (src.mono ? 0 : ATLAS_CODEPOINTS.length);
  return { ...font, ref: true, kb: (bytes * 4) / 3 / 1024 };
}

function fromTtf(label, face, rung) {
  const px = fitPxForHeight(face, rung);
  const glyphs = new Map();
  for (const cp of ATLAS_CODEPOINTS) {
    const g = rasterizeAA(face, px, cp, { missing: 'null' });
    if (g) glyphs.set(cp, g);
  }
  // Tight 4-bit boxes (rows padded to a byte) + 4 B box + 1 B advance per glyph, as base64.
  let bytes = ATLAS_CODEPOINTS.length * 5;
  for (const g of glyphs.values()) bytes += Math.ceil(g.w / 2) * g.h;
  return { ...finishFont(label, glyphs), px, kb: (bytes * 4) / 3 / 1024 };
}

const advanceOf = (font, cp) => font.glyphs.get(cp)?.advance ?? Math.round(font.lineH / 3) + 1;
const textWidth = (font, s) => [...s].reduce((w, ch) => w + advanceOf(font, ch.codePointAt(0)), 0);

/** Coverage canvas (0..15) → 8-bit gray PNG data URL, white or black text. */
function pngUrl(cv, white) {
  const raw = Buffer.alloc((cv.w + 1) * cv.h);
  for (let y = 0; y < cv.h; y++) {
    for (let x = 0; x < cv.w; x++) {
      const a = cv.data[y * cv.w + x];
      const [bg, fg] = white ? [0, 255] : [255, 0];
      raw[y * (cv.w + 1) + 1 + x] = bg + Math.round(((fg - bg) * a * 17) / 255);
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(cv.w, 0);
  ihdr.writeUInt32BE(cv.h, 4);
  ihdr[8] = 8; // 8-bit gray
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

const canvas = (w, h) => ({ w, h, data: new Uint8Array(w * h) });

/** One line at pen x, baseline row `base`; glyphs not in the face draw a hollow box. */
function drawLine(cv, font, str, x, base) {
  let pen = x;
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    const g = font.glyphs.get(cp);
    if (!g) {
      const bw = Math.max(3, Math.round(font.lineH / 3));
      const bh = Math.max(3, Math.round(font.lineH * 0.7));
      for (let y = 0; y < bh; y++) {
        for (let bx = 0; bx < bw; bx++) {
          if (y === 0 || y === bh - 1 || bx === 0 || bx === bw - 1)
            put(cv, pen + bx, base - bh + y, 15);
        }
      }
      pen += bw + 1;
      continue;
    }
    for (let r = 0; r < g.h; r++) {
      for (let c = 0; c < g.w; c++) put(cv, pen + g.x + c, base - g.top + r, g.alpha[r * g.w + c]);
    }
    pen += g.advance;
  }
}

function put(cv, x, y, a) {
  if (x < 0 || y < 0 || x >= cv.w || y >= cv.h || a === 0) return;
  const i = y * cv.w + x;
  cv.data[i] = Math.max(cv.data[i], a);
}

/** Greedy word wrap, like the widget layout; an over-long word is left to clip. */
function wrapWords(font, str, max) {
  const rows = [];
  let row = '';
  for (const word of str.split(' ')) {
    const next = row ? `${row} ${word}` : word;
    if (row && textWidth(font, next) > max) {
      rows.push(row);
      row = word;
    } else row = next;
  }
  return [...rows, row];
}

/** A key/strip tile: wrapped sample lines centred, stacked until the tile is full. */
function tile(font, [w, h]) {
  const cv = canvas(w, h);
  const rows = TILE_TEXT.flatMap((t) => wrapWords(font, t, w)).slice(
    0,
    Math.max(1, Math.floor(h / font.lineH)),
  );
  let y = Math.floor((h - rows.length * font.lineH) / 2);
  for (const row of rows) {
    drawLine(
      cv,
      font,
      row,
      Math.max(0, Math.floor((w - textWidth(font, row)) / 2)),
      y + font.ascent,
    );
    y += font.lineH;
  }
  return cv;
}

function wide(font, samples) {
  const w = Math.max(...samples.map((s) => textWidth(font, s))) + 4;
  const cv = canvas(w, samples.length * (font.lineH + 2) + 2);
  samples.forEach((s, i) => drawLine(cv, font, s, 2, 2 + i * (font.lineH + 2) + font.ascent));
  return cv;
}

const img = (cv, white, scale) =>
  `<img src="${pngUrl(cv, white)}" style="width:${cv.w * scale}px" width="${cv.w}" height="${cv.h}">`;

// The TTF name table rarely repeats the RFN clause; the family's OFL.txt does.
function meta(face, oflText) {
  const names = face.names.windows ?? face.names;
  const en = (k) => names[k]?.en ?? '';
  const text = ['copyright', 'license', 'licenseURL', 'description'].map(en).join(' ');
  const rfn = /with reserved font names? ["“][^"”]+["”]/i.exec(`${text}\n${oflText}`)?.[0];
  return {
    ellipsis: face.charToGlyphIndex(String.fromCodePoint(0x2026)) > 0,
    copyright: en('copyright'),
    version: en('version'),
    rfn: rfn ?? 'none stated',
    license: en('license').slice(0, 90),
  };
}

const hex = (cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

export async function writeSlimSheet(out, { samples, measure }) {
  const opentype = loadOpentype();
  const allSamples = [...samples, ...EXTRA_SAMPLES];
  const rungFonts = RUNGS.map(() => []); // per rung: cells in display order
  const rows = [];
  const info = [];
  const meanOf = (font) => textWidth(font, measure) / measure.length;

  for (const [i, src] of NARROW.entries()) {
    const f = fromBdf(src, parseBdf(readFileSync(await fetchCached(src.url), 'latin1')));
    rungFonts[i].push(f);
  }
  for (const [i, src] of REGULAR.entries()) {
    const f = fromBdf(src, parseBdf(readFileSync(await fetchCached(src.url), 'latin1')));
    rungFonts[i].push(f);
  }
  const totals = [];
  for (const cand of CANDIDATES) {
    const total = { name: cand.name, Light: 0, Regular: 0, best: 0 };
    const perRungKb = RUNGS.map(() => ({}));
    for (const weight of WEIGHTS) {
      const face = loadFace(opentype, await fetchCached(cand.files[weight]));
      const missing = ATLAS_CODEPOINTS.filter(
        (cp) => face.charToGlyphIndex(String.fromCodePoint(cp)) === 0,
      );
      info.push({
        cand: cand.name,
        weight,
        missing,
        ...meta(face, readFileSync(await fetchCached(cand.ofl), 'utf8')),
      });
      RUNGS.forEach((rung, i) => {
        const f = { ...fromTtf(`${cand.name} ${weight}`, face, rung), cand: cand.name, weight };
        rungFonts[i].push(f);
        total[weight] += f.kb;
        perRungKb[i][weight] = f.kb;
      });
    }
    total.best = perRungKb.reduce((s, k) => s + Math.min(k.Light, k.Regular), 0);
    totals.push(total);
  }

  const sections = RUNGS.map((rung, i) => {
    const cells = rungFonts[i].map((f) => {
      const mean = meanOf(f);
      rows.push({
        rung,
        font: f.label,
        px: f.px ?? '-',
        ink: f.lineH,
        mean: mean.toFixed(2),
        chars72: Math.floor(72 / mean),
        kb: f.kb.toFixed(1) + (f.ref ? ' (1-bit, today)' : ''),
      });
      const k = tile(f, KEY);
      const s = tile(f, STRIP);
      const scaleW = rung <= 16 ? 3 : rung <= 24 ? 2 : 1;
      return `<div class="cell"><h4>${esc(f.label)}${f.px ? ` @${f.px}px` : ''}</h4>
<p>ink ${f.lineH} rows, mean adv ${mean.toFixed(2)} px, ${Math.floor(72 / mean)} chars/72px, ${f.kb.toFixed(1)} KB${f.ref ? ' (today, 1-bit cell)' : ''}</p>
${img(k, true, 3)} ${img(k, false, 3)}<br>${img(s, true, 2)}<br>${img(wide(f, allSamples), true, scaleW)}</div>`;
    });
    return `<h2>Rung ${rung} px line height</h2><div class="row">${cells.join('\n')}</div>`;
  });

  const f2 = (n) => n.toFixed(1);
  const infoRows = info
    .map(
      (m) => `<tr><td>${esc(m.cand)} ${m.weight}</td><td>${m.ellipsis ? 'yes' : 'NO'}</td>
<td>${m.missing.length ? esc(m.missing.map(hex).join(' ')) : 'none'}</td><td>${esc(m.rfn)}</td><td>${esc(m.version)}</td><td>${esc(m.copyright)}</td></tr>`,
    )
    .join('\n');
  const totalRows = totals
    .map(
      (t) =>
        `<tr><td>${esc(t.name)}</td><td>${f2(t.Light)}</td><td>${f2(t.Regular)}</td><td>${f2(t.best)}</td></tr>`,
    )
    .join('\n');
  writeFileSync(
    out,
    `<!doctype html><meta charset="utf-8"><title>DeckBridge slim font spike</title>
<style>body{background:#222;color:#ddd;font:13px system-ui;margin:24px}
img{image-rendering:pixelated;margin:2px;border:1px solid #444}h2{margin:32px 0 8px}
h4{margin:0}p{margin:2px 0 6px;font-size:12px;color:#aaa}.row{display:flex;flex-wrap:wrap;gap:16px}
.cell{width:460px}table{border-collapse:collapse}td,th{border:1px solid #444;padding:2px 8px;text-align:left}</style>
<p>Key tiles 72×72 (×3), white on black and black on white; strip tile 176×112 (AKP05E slot, ×2);
last image: all samples, one per line. Hollow box = glyph not in the 192-glyph atlas set or missing
from the face (the atlas has no U+2013 or Czech ř/ž/ť/č/ů, so those samples show boxes in every face).
Mean advance over "${esc(measure)}". Atlas KB = tight 4-bit boxes, base64.</p>
<h2>Atlas total KB (6 rungs)</h2><table><tr><th>Candidate</th><th>All Light</th><th>All Regular</th><th>Cheapest weight per rung</th></tr>${totalRows}</table>
<h2>Coverage, ellipsis, reserved font name</h2><table><tr><th>Face</th><th>U+2026 native</th><th>Missing of 192</th><th>RFN</th><th>Version</th><th>Copyright</th></tr>${infoRows}</table>
${sections.join('\n')}`,
  );
  console.table(rows);
  console.table(
    totals.map((t) => ({ ...t, Light: f2(t.Light), Regular: f2(t.Regular), best: f2(t.best) })),
  );
  console.table(
    info.map((m) => ({
      face: `${m.cand} ${m.weight}`,
      ellipsis: m.ellipsis,
      missing: m.missing.map(hex).join(' '),
      rfn: m.rfn,
    })),
  );
  console.log(`wrote ${out}`);
}
