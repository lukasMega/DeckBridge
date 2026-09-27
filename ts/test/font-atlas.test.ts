import assert from 'tjs:assert';
import { FONT_LADDER, NARROW_LADDER, fontGlyphIndex } from '../src/assets/font-atlas.js';
import type { BitmapFont } from '../src/assets/font-atlas.js';
import { composeWidgetBmp } from '../src/widget-raster.js';
import { layoutWidget } from '../src/widget-layout.js';
import { test, summary } from './helpers/harness.js';

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

function checkDecodes(font: BitmapFont): void {
  const scale = font.scale ?? 1;
  const perGlyph = Math.ceil(font.width / scale / 8) * (font.height / scale);
  assert.equal(
    Buffer.from(font.bits, 'base64').length,
    GLYPHS * perGlyph,
    `${font.width}x${font.height}`,
  );
  if (font.advances) {
    const adv = Buffer.from(font.advances, 'base64');
    assert.equal(adv.length, GLYPHS);
    assert.ok(
      [...adv].every((a) => a > 0 && a <= font.width + 1),
      'sane advances',
    );
  }
}

test('every glyph of both ladders decodes', () => {
  for (const f of [...FONT_LADDER, ...NARROW_LADDER]) checkDecodes(f);
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

/** Foreground pixels of an 85×85 widget BMP, honouring the 4-byte row padding. */
function fgCount(bmp: Uint8Array): number {
  const rowSize = Math.ceil((85 * 3) / 4) * 4;
  let n = 0;
  for (let row = 0; row < 85; row++) {
    for (let x = 0; x < 85; x++) {
      const o = 54 + row * rowSize + x * 3;
      if (bmp[o] === 0xec && bmp[o + 1] === 0xe8 && bmp[o + 2] === 0xe8) n++;
    }
  }
  return n;
}

const inkOf = (text: string, font: 'regular' | 'narrow'): number =>
  fgCount(composeWidgetBmp([{ text, big: false }], 85, 85, { font }));

test('é renders in both families (more ink than e)', () => {
  for (const font of ['regular', 'narrow'] as const) {
    assert.ok(inkOf('é', font) > inkOf('e', font), font);
  }
});

test('the … placeholder renders in every font (it was blank before)', () => {
  for (const font of ['regular', 'narrow'] as const) {
    for (const textSize of [-2, -1, 0, 1, 2] as const) {
      const n = fgCount(composeWidgetBmp([{ text: '…', big: true }], 85, 85, { font, textSize }));
      assert.ok(n > 0, `${font} ${textSize}`);
    }
  }
  assert.equal(layoutWidget([{ text: '…', big: true }], 85, 85).clipped, false);
});

summary();
