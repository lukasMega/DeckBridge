import assert from 'tjs:assert';
import { composeLayout, composeWidgetBmp } from '../src/shared/widget-raster.js';
import { layoutWidget, type WidgetLine } from '../src/shared/widget-layout.js';
import type { ExtraKeyTextStyle } from '../src/web/contract.js';
import { test, summary } from './helpers/harness.js';

console.log('\ncomposeWidgetBmp');

const SIZE = 85;
const FG = [0xec, 0xe8, 0xe8]; // BGR of #e8e8ec
const BG = [0x14, 0x10, 0x10]; // BGR of #101014

test('produces a well-formed 24-bit BMP of the key size', () => {
  const buf = Buffer.from(composeWidgetBmp([{ text: '8', big: true }], SIZE));
  assert.equal(buf.toString('ascii', 0, 2), 'BM');
  assert.equal(buf.readUInt32LE(2), buf.length, 'declared file size matches');
  assert.equal(buf.readUInt32LE(18), SIZE, 'width');
  assert.equal(buf.readUInt32LE(22), SIZE, 'height');
  assert.equal(buf.readUInt16LE(28), 24, 'bpp');
});

/** Pixel (x, y) of an upright image stored bottom-up, as BGR. */
function pixel(bmp: Uint8Array, x: number, y: number): number[] {
  const b = Buffer.from(bmp);
  const w = b.readUInt32LE(18);
  const h = b.readUInt32LE(22);
  const o = 54 + (h - 1 - y) * Math.ceil((w * 3) / 4) * 4 + x * 3;
  return [b[o]!, b[o + 1]!, b[o + 2]!];
}

/** Every (x, y) whose colour is `bgr`. */
function pixelsOf(bmp: Uint8Array, bgr: readonly number[]): Array<[number, number]> {
  const b = Buffer.from(bmp);
  const w = b.readUInt32LE(18);
  const h = b.readUInt32LE(22);
  const out: Array<[number, number]> = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = pixel(bmp, x, y);
      if (p[0] === bgr[0] && p[1] === bgr[1] && p[2] === bgr[2]) out.push([x, y]);
    }
  }
  return out;
}

test('background + glyph foreground pixels present', () => {
  const bmp = composeWidgetBmp([{ text: '8', big: true }], SIZE);
  assert.deepEqual(pixel(bmp, 0, 0), BG);
  const fg = pixelsOf(bmp, FG).length;
  assert.ok(fg > 50, `glyph pixels rendered (got ${fg})`);
});

test('a non-square BMP gets its own width, height and row padding', () => {
  const buf = Buffer.from(composeWidgetBmp([{ text: '8', big: true }], 175, 30));
  assert.equal(buf.readUInt32LE(18), 175, 'width');
  assert.equal(buf.readUInt32LE(22), 30, 'height');
  assert.equal(buf.length, 54 + Math.ceil((175 * 3) / 4) * 4 * 30);
});

test('blank text renders pure background', () => {
  assert.equal(pixelsOf(composeWidgetBmp([{ text: ' ', big: true }], SIZE), FG).length, 0);
});

// Golden hashes captured from the pre-ladder renderer: default style must stay
// pixel-identical — except the default ellipsis on cut text, so `ellipsis: false` here.

console.log('\ncomposeWidgetBmp golden (default style)');

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

test('default style matches the pre-ladder renderer byte for byte', () => {
  for (const [w, h, lines, hash] of GOLDEN) {
    const bmp = composeWidgetBmp(lines, w, h, { ellipsis: false });
    assert.equal(fnv(bmp), hash, `${w}x${h} ${lines[0]!.text}`);
  }
});

test('only cut text changes with the default ellipsis', () => {
  for (const [w, h, lines, hash] of GOLDEN) {
    const same = fnv(composeWidgetBmp(lines, w, h)) === hash;
    assert.equal(same, !layoutWidget(lines, w, h, { ellipsis: false }).clipped, `${w}x${h}`);
  }
  assert.notEqual(fnv(composeWidgetBmp(LONG, 85, 85)), '0d9e167d');
});

// Raster options

console.log('\ncomposeLayout style');

const I: WidgetLine[] = [{ text: 'l', big: true }];

test('text and background colours land on known pixels', () => {
  const style: ExtraKeyTextStyle = { color: '#ffd60a', background: '#0a84ff' };
  const bmp = composeWidgetBmp(CLOCK, SIZE, SIZE, style);
  assert.deepEqual(pixel(bmp, 0, 0), [0xff, 0x84, 0x0a], 'background, BGR');
  const plain = pixelsOf(composeWidgetBmp(CLOCK, SIZE), FG);
  assert.ok(plain.length > 0);
  for (const [x, y] of plain) assert.deepEqual(pixel(bmp, x, y), [0x0a, 0xd6, 0xff]);
});

test('inverted swaps the custom colours', () => {
  const style: ExtraKeyTextStyle = { color: '#ffd60a', background: '#0a84ff' };
  const bmp = composeLayout(layoutWidget(CLOCK, SIZE, SIZE, style), SIZE, SIZE, true);
  assert.deepEqual(pixel(bmp, 0, 0), [0x0a, 0xd6, 0xff]);
});

/** Horizontal extent of the foreground pixels. */
function inkSpan(bmp: Uint8Array): [number, number] {
  const xs = pixelsOf(bmp, FG).map(([x]) => x);
  return [Math.min(...xs), Math.max(...xs)];
}

test('bold widens a glyph by 1 px', () => {
  const style: ExtraKeyTextStyle = { align: 'left' };
  const [a0, a1] = inkSpan(composeWidgetBmp(I, SIZE, SIZE, style));
  const [b0, b1] = inkSpan(composeWidgetBmp(I, SIZE, SIZE, { ...style, bold: true }));
  assert.equal(b0, a0);
  assert.equal(b1, a1 + 1);
});

test('outline rings the glyph without covering it', () => {
  const OUT = [0x00, 0x00, 0xff]; // BGR of #ff0000
  const plainLayout = layoutWidget(I, SIZE, SIZE, { align: 'left', valign: 'top' });
  const style: ExtraKeyTextStyle = { align: 'left', valign: 'top', outline: '#ff0000' };
  const bmp = composeWidgetBmp(I, SIZE, SIZE, style);
  // The outline shifts the pen 1 px right/down: compare against the shifted plain ink.
  const plain = pixelsOf(composeLayout(plainLayout, SIZE, SIZE), FG).map(([x, y]) => [
    x + 1,
    y + 1,
  ]);
  const fg = pixelsOf(bmp, FG);
  assert.deepEqual(fg, plain, 'foreground untouched');
  const ring = pixelsOf(bmp, OUT);
  assert.ok(ring.length > 0, 'outline drawn');
  const fgSet = new Set(fg.map(([x, y]) => `${x},${y}`));
  for (const [x, y] of ring) {
    assert.ok(!fgSet.has(`${x},${y}`), 'not over foreground');
    const near = [-1, 0, 1].some((dx) => [-1, 0, 1].some((dy) => fgSet.has(`${x + dx},${y + dy}`)));
    assert.ok(near, `ring pixel ${x},${y} touches the glyph`);
  }
});

test('outline of one glyph never covers its neighbor', () => {
  const lines: WidgetLine[] = [{ text: 'WW', big: true }];
  const style: ExtraKeyTextStyle = { outline: '#ff0000', font: 'narrow' };
  const plain = pixelsOf(composeWidgetBmp(lines, SIZE, SIZE, { font: 'narrow' }), FG).length;
  assert.equal(pixelsOf(composeWidgetBmp(lines, SIZE, SIZE, style), FG).length, plain);
});

summary();
