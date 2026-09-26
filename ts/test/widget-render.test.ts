import assert from 'tjs:assert';
import { composeWidgetBmp, layoutWidget, type WidgetLine } from '../src/widget-render.js';
import { test, summary } from './helpers/harness.js';

// composeWidgetBmp

console.log('\ncomposeWidgetBmp');

const SIZE = 85;

test('produces a well-formed 24-bit BMP of the key size', () => {
  const bmp = composeWidgetBmp([{ text: '8', big: true }], SIZE);
  const buf = Buffer.from(bmp);
  assert.equal(buf.toString('ascii', 0, 2), 'BM');
  assert.equal(buf.readUInt32LE(2), buf.length, 'declared file size matches');
  assert.equal(buf.readUInt32LE(18), SIZE, 'width');
  assert.equal(buf.readUInt32LE(22), SIZE, 'height');
  assert.equal(buf.readUInt16LE(28), 24, 'bpp');
});

/** Count foreground pixels, honouring the 4-byte BMP row padding. */
function countFg(buf: ReturnType<typeof Buffer.from>): number {
  const rowSize = Math.ceil((SIZE * 3) / 4) * 4;
  let fg = 0;
  for (let row = 0; row < SIZE; row++) {
    for (let x = 0; x < SIZE; x++) {
      const o = 54 + row * rowSize + x * 3;
      if (buf[o] === 0xec && buf[o + 1] === 0xe8 && buf[o + 2] === 0xe8) fg++;
    }
  }
  return fg;
}

test('background + glyph foreground pixels present', () => {
  const bmp = composeWidgetBmp([{ text: '8', big: true }], SIZE);
  const buf = Buffer.from(bmp);
  const rowSize = Math.ceil((SIZE * 3) / 4) * 4;
  // (0,0) top-left = last stored row (bottom-up) → background #101014 (BGR).
  const corner = 54 + (SIZE - 1) * rowSize;
  assert.deepEqual([...buf.subarray(corner, corner + 3)], [0x14, 0x10, 0x10]);
  const fg = countFg(buf);
  assert.ok(fg > 50, `glyph pixels rendered (got ${fg})`);
});

test('a non-square BMP gets its own width, height and row padding', () => {
  const buf = Buffer.from(composeWidgetBmp([{ text: '8', big: true }], 175, 30));
  assert.equal(buf.readUInt32LE(18), 175, 'width');
  assert.equal(buf.readUInt32LE(22), 30, 'height');
  assert.equal(buf.length, 54 + Math.ceil((175 * 3) / 4) * 4 * 30);
});

test('blank text renders pure background', () => {
  const bmp = composeWidgetBmp([{ text: ' ', big: true }], SIZE);
  assert.equal(countFg(Buffer.from(bmp)), 0);
});

// Golden hashes captured from the pre-ladder renderer: text size 0 must stay pixel-identical.

console.log('\ncomposeWidgetBmp golden (text size 0)');

function fnv(b: Uint8Array): string {
  let h = 0x811c9dc5;
  for (const x of b) h = Math.imul(h ^ x, 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

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

const GOLDEN: ReadonlyArray<[number, number, WidgetLine[], string]> = [
  [85, 85, CLOCK, '235c9c65'],
  [85, 85, DATE, '7e529c25'],
  [85, 85, THREE, '120fbd1d'],
  [85, 85, LONG, '0d9e167d'],
  [112, 112, CLOCK, '7d692e15'],
  [112, 112, DATE, 'b4e91215'],
  [112, 112, THREE, '2275714d'],
  [112, 112, LONG, '47a079d5'],
  [176, 112, CLOCK, '81086585'],
  [176, 112, DATE, 'a346e585'],
  [176, 112, THREE, '613f6edd'],
  [176, 112, LONG, '79dac8c5'],
];

test('text size 0 matches the pre-ladder renderer byte for byte', () => {
  for (const [w, h, lines, hash] of GOLDEN) {
    assert.equal(fnv(composeWidgetBmp(lines, w, h)), hash, `${w}x${h} ${lines[0]!.text}`);
  }
});

// layoutWidget

console.log('\nlayoutWidget');

const sizes = (
  w: number,
  h: number,
  lines: WidgetLine[],
  size: Parameters<typeof layoutWidget>[3],
) => layoutWidget(lines, w, h, size).lines.map((l) => `${l.font.width}x${l.font.height}`);

test('steps move each role along the ladder', () => {
  assert.deepEqual(sizes(112, 112, DATE, 0), ['8x16', '16x32', '8x16']);
  assert.deepEqual(sizes(112, 112, DATE, 1), ['12x24', '32x64', '12x24']);
  assert.deepEqual(sizes(112, 112, DATE, -1), ['6x12', '12x24', '6x12']);
  assert.deepEqual(sizes(85, 85, THREE, -2), ['5x8', '5x8', '5x8']);
});

test('steps clamp at the ladder ends', () => {
  assert.deepEqual(sizes(176, 112, CLOCK, 2), ['32x64']);
  assert.deepEqual(sizes(85, 85, [{ text: 'a', big: false }], 2), ['16x32']);
  assert.deepEqual(sizes(85, 85, CLOCK, -2), ['8x16']);
});

test('clipped: too wide or too tall', () => {
  assert.equal(layoutWidget(CLOCK, 85, 85, 0).clipped, false);
  assert.equal(layoutWidget(CLOCK, 85, 85, 1).clipped, true, '5 × 32 px > 85');
  assert.equal(layoutWidget(LONG, 85, 85, 0).clipped, true);
  assert.equal(layoutWidget(DATE, 112, 112, 1).clipped, false, '24 + 64 + 24 = 112');
  assert.equal(layoutWidget(DATE, 85, 85, 1).clipped, true, '112 px of lines > 85');
});

test('truncated lines are centred on what is drawn', () => {
  const [line] = layoutWidget(CLOCK, 85, 85, 1).lines;
  assert.equal(line!.chars.join(''), '09');
  assert.equal(line!.x, Math.floor((85 - 2 * 32) / 2));
});

test('fit picks the largest step that shows everything', () => {
  assert.deepEqual(sizes(85, 85, CLOCK, 'fit'), ['16x32']);
  assert.deepEqual(sizes(176, 112, CLOCK, 'fit'), ['32x64']);
  assert.deepEqual(sizes(112, 112, DATE, 'fit'), ['12x24', '32x64', '12x24']);
  assert.deepEqual(sizes(85, 85, THREE, 'fit'), ['12x24', '12x24', '12x24']);
  assert.equal(layoutWidget(LONG, 85, 85, 'fit').clipped, true, 'nothing fits 25 chars');
  assert.deepEqual(sizes(85, 85, LONG, 'fit'), ['5x8']);
  assert.deepEqual(sizes(176, 112, LONG, 'fit'), ['6x12'], '25 × 6 = 150 ≤ 176');
});

// wrapping

console.log('\nlayoutWidget wrap');

const rows = (
  w: number,
  h: number,
  lines: WidgetLine[],
  size: Parameters<typeof layoutWidget>[3],
  wrap?: 'words' | 'chars',
) => layoutWidget(lines, w, h, size, wrap).lines.map((l) => l.chars.join(''));

const SENTENCE: WidgetLine[] = [{ text: 'The quick brown fox jumps', big: false }];

test('off: a long line is cut (unchanged behaviour)', () => {
  assert.deepEqual(rows(85, 85, SENTENCE, 0), ['The quick '], '85 / 8 = 10 chars');
});

test('words: breaks at spaces, rows stay centred, nothing clipped', () => {
  const layout = layoutWidget(SENTENCE, 85, 85, 0, 'words');
  assert.deepEqual(
    layout.lines.map((l) => l.chars.join('')),
    ['The quick', 'brown fox', 'jumps'],
  );
  assert.equal(layout.clipped, false);
  assert.equal(layout.lines[2]!.x, Math.floor((85 - 5 * 8) / 2));
  assert.equal(layout.lines[0]!.y, Math.floor((85 - 3 * 16) / 2));
});

test('words: an over-long word is split mid-word', () => {
  assert.deepEqual(rows(85, 85, [{ text: 'a supercalifragilistic b', big: false }], 0, 'words'), [
    'a',
    'supercalif',
    'ragilistic',
    'b',
  ]);
});

test('chars: fills each row, no leading/trailing spaces', () => {
  assert.deepEqual(rows(85, 85, SENTENCE, 0, 'chars'), ['The quick', 'brown fox', 'jumps']);
  assert.deepEqual(rows(85, 85, [{ text: 'abcdefghijklmnop', big: false }], 0, 'chars'), [
    'abcdefghij',
    'klmnop',
  ]);
});

test('too many rows for the height → clipped', () => {
  assert.equal(layoutWidget(SENTENCE, 85, 85, 2, 'words').clipped, true);
});

test('fit with wrap picks the largest size whose wrapped rows fit', () => {
  const fit = layoutWidget(SENTENCE, 85, 85, 'fit', 'words');
  assert.equal(fit.clipped, false);
  // 12×24 fits 7 chars/row → 5 rows = 120 px > 85, so fit settles on 8×16 (3 rows).
  assert.equal(fit.lines[0]!.font.width, 8);
  assert.equal(
    layoutWidget(SENTENCE, 176, 112, 'fit', 'words').lines[0]!.font.width,
    16,
    '3 rows × 32 = 96',
  );
});

summary();
