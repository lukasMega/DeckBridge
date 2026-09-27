import assert from 'tjs:assert';
import type { BitmapFont } from '../src/assets/font-atlas.js';
import { FONT_LADDER, fontGlyphIndex, NARROW_LADDER } from '../src/assets/font-atlas.js';
import {
  glyphAdvance,
  layoutWidget,
  textWidth,
  type WidgetLine,
} from '../src/shared/widget-layout.js';
import type { ExtraKeyTextStyle } from '../src/web/contract.js';
import { test, summary } from './helpers/harness.js';

const CLOCK: WidgetLine[] = [{ text: '09:05', big: true }];
const DATE: WidgetLine[] = [
  { text: 'Wed', big: false },
  { text: '15', big: true },
  { text: 'Jul', big: false },
];
const THREE: WidgetLine[] = [
  { text: 'a', big: false },
  { text: 'bb', big: false },
  { text: 'ccc', big: false },
];
const LONG: WidgetLine[] = [{ text: 'The quick brown fox jumps', big: false }];
const CUT: ExtraKeyTextStyle = { ellipsis: false };

// layoutWidget

console.log('\nlayoutWidget');

const sizes = (w: number, h: number, lines: WidgetLine[], style: ExtraKeyTextStyle) =>
  layoutWidget(lines, w, h, style).lines.map((l) => `${l.font.width}x${l.font.height}`);

test('steps move each role along the ladder', () => {
  assert.deepEqual(sizes(112, 112, DATE, {}), ['8x16', '16x32', '8x16']);
  assert.deepEqual(sizes(112, 112, DATE, { textSize: 1 }), ['12x24', '32x64', '12x24']);
  assert.deepEqual(sizes(112, 112, DATE, { textSize: -1 }), ['6x12', '12x24', '6x12']);
  assert.deepEqual(sizes(85, 85, THREE, { textSize: -2 }), ['5x8', '5x8', '5x8']);
});

test('steps clamp at the ladder ends', () => {
  assert.deepEqual(sizes(176, 112, CLOCK, { textSize: 2 }), ['32x64']);
  assert.deepEqual(sizes(85, 85, [{ text: 'a', big: false }], { textSize: 2 }), ['16x32']);
  assert.deepEqual(sizes(85, 85, CLOCK, { textSize: -2 }), ['8x16']);
});

test('clipped: too wide or too tall', () => {
  assert.equal(layoutWidget(CLOCK, 85, 85).clipped, false);
  assert.equal(layoutWidget(CLOCK, 85, 85, { textSize: 1 }).clipped, true, '5 × 32 px > 85');
  assert.equal(layoutWidget(LONG, 85, 85).clipped, true);
  assert.equal(layoutWidget(DATE, 112, 112, { textSize: 1 }).clipped, false, '24 + 64 + 24');
  assert.equal(layoutWidget(DATE, 85, 85, { textSize: 1 }).clipped, true, '112 px > 85');
});

test('truncated lines are centred on what is drawn', () => {
  const [line] = layoutWidget(CLOCK, 85, 85, { ...CUT, textSize: 1 }).lines;
  assert.equal(line!.chars.join(''), '09');
  assert.equal(line!.x, Math.floor((85 - 2 * 32) / 2));
});

test('fit picks the largest step that shows everything', () => {
  const fit: ExtraKeyTextStyle = { textSize: 'fit' };
  assert.deepEqual(sizes(85, 85, CLOCK, fit), ['16x32']);
  assert.deepEqual(sizes(176, 112, CLOCK, fit), ['32x64']);
  assert.deepEqual(sizes(112, 112, DATE, fit), ['12x24', '32x64', '12x24']);
  assert.deepEqual(sizes(85, 85, THREE, fit), ['12x24', '12x24', '12x24']);
  assert.equal(layoutWidget(LONG, 85, 85, fit).clipped, true, 'nothing fits 25 chars');
  assert.deepEqual(sizes(85, 85, LONG, fit), ['5x8']);
  assert.deepEqual(sizes(176, 112, LONG, fit), ['6x12'], '25 × 6 = 150 ≤ 176');
});

// ellipsis

console.log('\nlayoutWidget ellipsis');

const texts = (w: number, h: number, lines: WidgetLine[], style: ExtraKeyTextStyle = {}) =>
  layoutWidget(lines, w, h, style).lines.map((l) => l.chars.join(''));

test('default: a cut row ends with … and still reports clipped', () => {
  const layout = layoutWidget(LONG, 85, 85);
  assert.deepEqual(
    layout.lines.map((l) => l.chars.join('')),
    ['The quick…'],
  );
  assert.equal(layout.clipped, true);
  assert.deepEqual(texts(85, 85, LONG, CUT), ['The quick '], 'off: plain cut');
});

test('… drops trailing spaces and only touches cut rows', () => {
  assert.deepEqual(texts(45, 45, LONG), ['The…'], '5 cells: "The q" → "The …" → "The…"');
  assert.deepEqual(texts(85, 85, CLOCK), ['09:05'], 'fits: unchanged');
});

test('… that does not fit at all leaves the plain cut', () => {
  assert.deepEqual(texts(8, 16, [{ text: 'ab', big: false }]), ['a']);
  assert.deepEqual(texts(7, 16, [{ text: 'ab', big: false }]), ['']);
});

// alignment, padding, line gap

console.log('\nlayoutWidget alignment + spacing');

const place = (style: ExtraKeyTextStyle, lines = THREE, w = 85, h = 85) =>
  layoutWidget(lines, w, h, style).lines.map((l) => [l.x, l.y]);

test('align places each row inside the box', () => {
  assert.deepEqual(
    place({ align: 'left' }).map(([x]) => x),
    [0, 0, 0],
  );
  assert.deepEqual(
    place({ align: 'right' }).map(([x]) => x),
    [85 - 8, 85 - 16, 85 - 24],
  );
  assert.deepEqual(
    place({}).map(([x]) => x),
    [38, 34, 30],
  );
});

test('valign places the block of rows', () => {
  assert.deepEqual(
    place({ valign: 'top' }).map(([, y]) => y),
    [0, 16, 32],
  );
  assert.deepEqual(
    place({ valign: 'bottom' }).map(([, y]) => y),
    [85 - 48, 85 - 32, 85 - 16],
  );
  assert.deepEqual(
    place({}).map(([, y]) => y),
    [18, 34, 50],
  );
});

test('an overflowing block starts at the top, whatever the alignment', () => {
  const tall = { textSize: 2 as const, valign: 'bottom' as const };
  assert.equal(place(tall)[0]![1], 0);
});

test('padding shrinks the box on every side', () => {
  assert.deepEqual(place({ padding: 5, align: 'left', valign: 'top' })[0], [5, 5]);
  assert.deepEqual(place({ padding: 5, align: 'right', valign: 'bottom' })[2], [85 - 5 - 24, 64]);
  assert.deepEqual(texts(85, 85, LONG, { ...CUT, padding: 10 }), ['The quic'], '65 px → 8 cells');
  assert.equal(layoutWidget(DATE, 112, 112, { textSize: 1, padding: 1 }).clipped, true);
});

test('lineGap separates rows and counts toward the height', () => {
  assert.deepEqual(
    place({ lineGap: 4, valign: 'top' }).map(([, y]) => y),
    [0, 20, 40],
  );
  assert.deepEqual(
    place({ lineGap: 4 }).map(([, y]) => y),
    [14, 34, 54],
  );
  assert.equal(layoutWidget(DATE, 112, 112, { textSize: 1, lineGap: 1 }).clipped, true);
});

// wrapping

console.log('\nlayoutWidget wrap');

const SENTENCE: WidgetLine[] = [{ text: 'The quick brown fox jumps', big: false }];

test('words: breaks at spaces, rows stay centred, nothing clipped', () => {
  const layout = layoutWidget(SENTENCE, 85, 85, { wrap: 'words' });
  assert.deepEqual(
    layout.lines.map((l) => l.chars.join('')),
    ['The quick', 'brown fox', 'jumps'],
  );
  assert.equal(layout.clipped, false);
  assert.equal(layout.lines[2]!.x, Math.floor((85 - 5 * 8) / 2));
  assert.equal(layout.lines[0]!.y, Math.floor((85 - 3 * 16) / 2));
});

test('words: an over-long word is split mid-word', () => {
  assert.deepEqual(
    texts(85, 85, [{ text: 'a supercalifragilistic b', big: false }], { wrap: 'words' }),
    ['a', 'supercalif', 'ragilistic', 'b'],
  );
});

test('chars: fills each row, no leading/trailing spaces', () => {
  assert.deepEqual(texts(85, 85, SENTENCE, { wrap: 'chars' }), ['The quick', 'brown fox', 'jumps']);
  assert.deepEqual(texts(85, 85, [{ text: 'abcdefghijklmnop', big: false }], { wrap: 'chars' }), [
    'abcdefghij',
    'klmnop',
  ]);
});

test('too many rows for the height → clipped', () => {
  assert.equal(layoutWidget(SENTENCE, 85, 85, { textSize: 2, wrap: 'words' }).clipped, true);
});

test('fit with wrap picks the largest size whose wrapped rows fit', () => {
  const fit = layoutWidget(SENTENCE, 85, 85, { textSize: 'fit', wrap: 'words' });
  assert.equal(fit.clipped, false);
  // 12×24 fits 7 chars/row → 5 rows = 120 px > 85, so fit settles on 8×16 (3 rows).
  assert.equal(fit.lines[0]!.font.width, 8);
  assert.equal(
    layoutWidget(SENTENCE, 176, 112, { textSize: 'fit', wrap: 'words' }).lines[0]!.font.width,
    16,
    '3 rows × 32 = 96',
  );
});

// proportional (Narrow) font

console.log('\nproportional widths');

/** A fake proportional font: only 'i' (2 px), 'm' (6 px) and space (3 px) have advances. */
function fakeFont(): BitmapFont {
  const adv = new Uint8Array(192);
  adv[fontGlyphIndex(0x69)] = 2;
  adv[fontGlyphIndex(0x6d)] = 6;
  adv[fontGlyphIndex(0x20)] = 3;
  return { width: 7, height: 10, bits: '', advances: Buffer.from(adv).toString('base64') };
}

test('glyphAdvance / textWidth use per-glyph advances; bold adds 1 px per glyph', () => {
  const f = fakeFont();
  assert.equal(glyphAdvance(f, 0x69), 2);
  assert.equal(glyphAdvance(f, 0x6d), 6);
  assert.equal(glyphAdvance(f, 0x4e00), 7, 'uncovered glyph: cell width');
  assert.equal(textWidth(f, Array.from('im im')), 2 + 6 + 3 + 2 + 6);
  assert.equal(textWidth(f, Array.from('im'), true), 2 + 6 + 2);
  const mono = { width: 8, height: 16, bits: '' };
  assert.equal(textWidth(mono, Array.from('im')), 16, 'monospace: cell width');
});

const narrow: ExtraKeyTextStyle = { font: 'narrow' };

test('narrow rows are measured in pixels: iiii is narrower than mmmm', () => {
  const [i4, m4] = layoutWidget(
    [
      { text: 'iiii', big: false },
      { text: 'mmmm', big: false },
    ],
    85,
    85,
    narrow,
  ).lines;
  const wi = textWidth(i4!.font, i4!.chars);
  const wm = textWidth(m4!.font, m4!.chars);
  assert.ok(wi < wm, `${wi} < ${wm}`);
  assert.equal(i4!.x, Math.floor((85 - wi) / 2), 'centred on its pixel width');
});

test('narrow fits more characters on a row than regular', () => {
  const regular = texts(85, 85, LONG, CUT)[0]!;
  const nar = texts(85, 85, LONG, { ...narrow, ...CUT })[0]!;
  assert.ok(nar.length > regular.length, `${nar.length} > ${regular.length}`);
  const [row] = layoutWidget(LONG, 85, 85, { ...narrow, ...CUT }).lines;
  assert.ok(textWidth(row!.font, row!.chars) <= 85);
});

test('narrow wrap + fit measure pixels too', () => {
  const layout = layoutWidget(SENTENCE, 85, 85, { ...narrow, textSize: 'fit', wrap: 'words' });
  assert.equal(layout.clipped, false);
  for (const l of layout.lines) assert.ok(textWidth(l.font, l.chars) <= 85, l.chars.join(''));
  const rung = NARROW_LADDER.indexOf(layout.lines[0]!.font);
  const reg = layoutWidget(SENTENCE, 85, 85, { textSize: 'fit', wrap: 'words' }).lines[0]!.font;
  assert.ok(rung >= FONT_LADDER.indexOf(reg), `narrow rung ${rung}`);
});

test('bold and outline widen rows; outline shifts the pen 1 px in', () => {
  const plain = layoutWidget(CLOCK, 176, 112).lines[0]!;
  const bold = layoutWidget(CLOCK, 176, 112, { bold: true }).lines[0]!;
  assert.equal(bold.x, plain.x - 3, '5 glyphs + 5 px, centred: 2 px left (floor)');
  const ring = layoutWidget(CLOCK, 176, 112, { outline: '#000000', align: 'left', valign: 'top' });
  assert.deepEqual([ring.lines[0]!.x, ring.lines[0]!.y], [1, 1]);
  assert.equal(layoutWidget(CLOCK, 81, 34, { outline: '#000000' }).clipped, true, '80 + 2 > 81');
  assert.equal(layoutWidget(CLOCK, 81, 34).clipped, false);
});

summary();
