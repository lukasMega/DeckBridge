import assert from 'tjs:assert';
import { FONT_LADDER, NARROW_LADDER, SLIM_LADDER } from '../src/assets/font-atlas.js';
import type { BitmapFont } from '../src/assets/font-atlas.js';
import { fontGlyphIndex } from '../src/assets/font-glyph-index.js';
import { composeWidgetBmp } from '../src/shared/widget-raster.js';
import { layoutWidget } from '../src/shared/widget-layout.js';
import { test, testAsync, summary } from './helpers/harness.js';

console.log('\nfont atlas');

const GLYPHS = 192;

test('fontGlyphIndex covers ASCII, Latin-1 and U+2026 in one run', () => {
  assert.equal(fontGlyphIndex(31), -1);
  assert.equal(fontGlyphIndex(32), 0);
  assert.equal(fontGlyphIndex(126), 94);
  assert.equal(fontGlyphIndex(127), -1);
  assert.equal(fontGlyphIndex(0x9f), -1);
  assert.equal(fontGlyphIndex(0xa0), 95);
  assert.equal(fontGlyphIndex(0xff), 190);
  assert.equal(fontGlyphIndex(0x100), -1);
  assert.equal(fontGlyphIndex(0x2026), GLYPHS - 1);
  assert.equal(fontGlyphIndex(0x2025), -1);
});

function checkAlpha(font: BitmapFont & { kind: 'alpha' }): void {
  const scale = font.scale ?? 1;
  const boxes = Buffer.from(font.boxes, 'latin1');
  assert.equal(boxes.length, GLYPHS * 4, 'boxes: 4 bytes per glyph');
  let bytes = 0;
  for (let i = 0; i < GLYPHS; i++) {
    const [top, w, h] = [boxes[i * 4 + 1]!, boxes[i * 4 + 2]!, boxes[i * 4 + 3]!];
    bytes += Math.ceil(w / 2) * h;
    assert.ok((top + h) * scale <= font.height, `glyph ${i} fits ${font.height} rows`);
  }
  assert.equal(Buffer.from(font.alpha, 'latin1').length, bytes, 'alpha = sum of box sizes');
}

function checkDecodes(font: BitmapFont): void {
  const scale = font.scale ?? 1;
  if (font.kind === 'alpha') checkAlpha(font);
  else checkBits(font, scale);
  if (font.advances) {
    const adv = Buffer.from(font.advances, 'latin1');
    assert.equal(adv.length, GLYPHS);
    assert.ok(
      [...adv].every((a) => a > 0 && a <= font.width + 1),
      'sane advances',
    );
  }
}

function checkBits(font: BitmapFont & { bits: string }, scale: number): void {
  const perGlyph = Math.ceil(font.width / scale / 8) * (font.height / scale);
  assert.equal(
    Buffer.from(font.bits, 'latin1').length,
    GLYPHS * perGlyph,
    `${font.width}x${font.height}`,
  );
}

test('every glyph of every ladder decodes', () => {
  for (const f of [...FONT_LADDER, ...NARROW_LADDER, ...SLIM_LADDER]) checkDecodes(f);
});

/** [top, bottom] cell rows of ink per glyph (U+0021..U+007E), (none for an empty glyph). */
function glyphRows(font: BitmapFont, i: number): Array<[number, number]> {
  if (font.kind === 'alpha') {
    const boxes = Buffer.from(font.boxes, 'latin1');
    const [top, h] = [boxes[i * 4 + 1]!, boxes[i * 4 + 3]!];
    return h > 0 ? [[top, top + h - 1]] : [];
  }
  const rows = font.height / (font.scale ?? 1);
  const rowBytes = Math.ceil(font.width / (font.scale ?? 1) / 8);
  const bits = Buffer.from(font.bits, 'latin1');
  const out: Array<[number, number]> = [];
  for (let r = 0; r < rows; r++) {
    const base = (i * rows + r) * rowBytes;
    if (bits.subarray(base, base + rowBytes).some((v) => v !== 0)) out.push([r, r]);
  }
  return out;
}

/** ASCII (U+0021..U+007E) ink [top, height], measured from the packed glyph data. */
function measuredInk(font: BitmapFont): [number, number] {
  const spans = Array.from({ length: 94 }, (_, k) => glyphRows(font, k + 1)).flat();
  const lo = Math.min(...spans.map(([t]) => t));
  const hi = Math.max(...spans.map(([, b]) => b));
  const scale = font.scale ?? 1;
  return [lo * scale, (hi - lo + 1) * scale];
}

test('every font carries its ASCII ink extent inside the cell', () => {
  for (const f of [...FONT_LADDER, ...NARROW_LADDER, ...SLIM_LADDER]) {
    assert.ok(f.inkTop >= 0 && f.inkHeight > 0, `${f.height}: ink rows`);
    assert.ok(f.inkTop + f.inkHeight <= f.height, `${f.height}: ink inside the cell`);
    assert.deepEqual([f.inkTop, f.inkHeight], measuredInk(f), `${f.width}x${f.height} extent`);
  }
  const spleen16 = FONT_LADDER[2]!;
  assert.ok(spleen16.inkHeight < spleen16.height, 'Spleen 8x16 has blank rows to pack away');
});

test('the slim ladder has six rungs of non-decreasing height, mixing kinds', () => {
  assert.equal(SLIM_LADDER.length, FONT_LADDER.length);
  const heights = SLIM_LADDER.map((f) => f.height);
  assert.deepEqual(
    heights,
    heights.toSorted((a, b) => a - b),
  );
  assert.equal(SLIM_LADDER[0], NARROW_LADDER[0], 'the 8 px rung reuses NARROW_8');
  assert.deepEqual(
    SLIM_LADDER.map((f) => f.kind ?? 'bits'),
    ['bits', 'alpha', 'alpha', 'alpha', 'alpha', 'alpha'],
  );
  assert.equal(SLIM_LADDER[5]!.scale, 2);
  assert.equal(SLIM_LADDER[5]!.height, SLIM_LADDER[4]!.height * 2);
});

test('the narrow ladder has one rung per Spleen rung', () => {
  assert.equal(NARROW_LADDER.length, FONT_LADDER.length);
  // helvR 08/10/12/18/24 full-Latin-1 ink heights; the last is 24 × 2.
  assert.deepEqual(
    NARROW_LADDER.map((f) => f.height),
    [11, 13, 15, 22, 29, 58],
  );
  assert.ok(
    NARROW_LADDER.every((f) => f.advances !== undefined),
    'proportional',
  );
});

/** Inked pixels of an 85×85 widget BMP, honouring the 4-byte row padding. */
function fgCount(bmp: Uint8Array): number {
  const rowSize = Math.ceil((85 * 3) / 4) * 4;
  let n = 0;
  for (let row = 0; row < 85; row++) {
    for (let x = 0; x < 85; x++) {
      const o = 54 + row * rowSize + x * 3;
      // Not the #101014 background: thin AA strokes may never reach full coverage.
      if (bmp[o] !== 0x14 || bmp[o + 1] !== 0x10 || bmp[o + 2] !== 0x10) n++;
    }
  }
  return n;
}

const inkOf = (text: string, font: 'regular' | 'narrow' | 'slim'): number =>
  fgCount(composeWidgetBmp([{ text, big: false }], 85, 85, { font }));

test('é renders in every family (more ink than e)', () => {
  for (const font of ['regular', 'narrow', 'slim'] as const) {
    assert.ok(inkOf('é', font) > inkOf('e', font), font);
  }
});

test('the … placeholder renders in every font (it was blank before)', () => {
  for (const font of ['regular', 'narrow', 'slim'] as const) {
    for (const textSize of [-2, -1, 0, 1, 2] as const) {
      const n = fgCount(composeWidgetBmp([{ text: '…', big: true }], 85, 85, { font, textSize }));
      assert.ok(n > 0, `${font} ${textSize}`);
    }
  }
  assert.equal(layoutWidget([{ text: '…', big: true }], 85, 85).clipped, false);
});

// Golden fingerprints taken from the base64 atlas, before the data moved to latin1 strings:
// the decoded bytes, and every glyph drawn from them, must not drift.
const ATLAS_SHA256 = '97b9723d9268150bc0f85f0115702524e00bf089ec2969f39a5343d274a5f05b';
const RENDER_SHA256 = '334b4845bdc25600e65f2420fc80085e8cb210cc6de72c87a8b6aa3f63acdfe5';

async function sha256Hex(parts: Uint8Array[]): Promise<string> {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

await testAsync('decoded atlas bytes are unchanged', async () => {
  const fonts = [...new Set([...FONT_LADDER, ...NARROW_LADDER, ...SLIM_LADDER])];
  assert.equal(fonts.length, 17);
  const parts: Uint8Array[] = [];
  for (const f of fonts) {
    for (const field of ['bits', 'alpha', 'boxes', 'advances'] as const) {
      const data = (f as unknown as Partial<Record<typeof field, string>>)[field];
      if (data === undefined) continue;
      let wide = false;
      for (let i = 0; i < data.length; i++) wide ||= data.charCodeAt(i) > 0xff;
      assert.ok(!wide, `${field} holds only latin1 chars`);
      const bytes = Buffer.from(data, 'latin1');
      assert.equal(bytes.length, data.length, 'one byte per char');
      parts.push(new Uint8Array([field.length, bytes.length & 0xff, bytes.length >> 8]), bytes);
    }
  }
  assert.equal(await sha256Hex(parts), ATLAS_SHA256);
});

await testAsync('widgets render the same pixels in every family and size', async () => {
  const lines = [
    { text: 'Hé…W', big: true },
    { text: 'gjpq ÿÀ 019', big: false },
  ];
  const bmps: Uint8Array[] = [];
  for (const font of ['regular', 'narrow', 'slim'] as const) {
    for (const textSize of [-2, -1, 0, 1, 2] as const) {
      bmps.push(composeWidgetBmp(lines, 85, 85, { font, textSize }));
      bmps.push(composeWidgetBmp(lines, 85, 85, { font, textSize, bold: true }));
    }
  }
  assert.equal(await sha256Hex(bmps), RENDER_SHA256);
});

summary();
