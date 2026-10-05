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

test('each call returns an independent buffer that starts at offset 0', () => {
  const a = composeWidgetBmp([{ text: '8', big: true }], SIZE);
  const b = composeWidgetBmp([{ text: '8', big: true }], SIZE);
  assert.equal(a.byteOffset, 0);
  assert.equal(a.byteLength, a.buffer.byteLength, 'view spans exactly its own allocation');
  assert.deepEqual(Array.from(a), Array.from(b), 'byte-identical');
  a.fill(0);
  assert.equal(b[0], 0x42, 'mutating one result leaves the next intact');
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

const slim: ExtraKeyTextStyle = { font: 'slim' };

/** Every pixel differing from the background colour. */
function inked(bmp: Uint8Array): Array<[number, number]> {
  const b = Buffer.from(bmp);
  const [w, h] = [b.readUInt32LE(18), b.readUInt32LE(22)];
  const out: Array<[number, number]> = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = pixel(bmp, x, y);
      if (p[0] !== BG[0] || p[1] !== BG[1] || p[2] !== BG[2]) out.push([x, y]);
    }
  }
  return out;
}

const between = (v: number, i: number): boolean =>
  Math.min(BG[i]!, FG[i]!) < v && v < Math.max(BG[i]!, FG[i]!);

test('slim text is anti-aliased: partial pixels strictly between bg and fg, full ones exact', () => {
  for (const big of [true, false]) {
    const bmp = composeWidgetBmp([{ text: 'Slim 8%', big }], SIZE, SIZE, slim);
    const mid = inked(bmp).filter(([x, y]) => pixel(bmp, x, y).every((v, i) => between(v, i)));
    assert.ok(mid.length > 10, `AA pixels (big ${big}): ${mid.length}`);
    assert.ok(pixelsOf(bmp, FG).length > 0, `fully covered pixels equal fg (big ${big})`);
  }
});

test('slim blend never leaves the bg..fg range', () => {
  const bmp = composeWidgetBmp([{ text: 'Wg@', big: true }], SIZE, SIZE, { ...slim, bold: true });
  for (const [x, y] of inked(bmp)) {
    pixel(bmp, x, y).forEach((v, i) => {
      assert.ok(v >= Math.min(BG[i]!, FG[i]!) && v <= Math.max(BG[i]!, FG[i]!), `${x},${y}`);
    });
  }
});

/** Horizontal extent of the inked pixels. */
function span(bmp: Uint8Array): number {
  const xs = inked(bmp).map(([x]) => x);
  return Math.max(...xs) - Math.min(...xs) + 1;
}

test('slim bold widens a glyph by 1 px', () => {
  const lines: WidgetLine[] = [{ text: 'H', big: true }];
  const plain = span(composeWidgetBmp(lines, SIZE, SIZE, slim));
  assert.equal(span(composeWidgetBmp(lines, SIZE, SIZE, { ...slim, bold: true })), plain + 1);
});

test('slim outline never covers a neighbouring glyph', () => {
  const lines: WidgetLine[] = [{ text: 'WW', big: true }];
  const plain = pixelsOf(composeWidgetBmp(lines, SIZE, SIZE, slim), FG).length;
  const ringed = composeWidgetBmp(lines, SIZE, SIZE, { ...slim, outline: '#ff0000' });
  assert.equal(pixelsOf(ringed, FG).length, plain);
  assert.ok(pixelsOf(ringed, [0x00, 0x00, 0xff]).length > 0, 'ring drawn');
});

/** First and last image row holding a non-background pixel. */
function inkRows(bmp: Uint8Array): [number, number] {
  const b = Buffer.from(bmp);
  const [w, h] = [b.readUInt32LE(18), b.readUInt32LE(22)];
  const rows: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = pixel(bmp, x, y);
      if (p[0] !== BG[0] || p[1] !== BG[1] || p[2] !== BG[2]) {
        rows.push(y);
        break;
      }
    }
  }
  return [rows[0]!, rows.at(-1)!];
}

test('tightLines off is byte-identical to the default style', () => {
  const lines = [
    { text: 'Åg|', big: false },
    { text: '12:34', big: true },
  ];
  for (const font of ['regular', 'narrow', 'slim'] as const) {
    const a = composeWidgetBmp(lines, SIZE, SIZE, { font });
    const b = composeWidgetBmp(lines, SIZE, SIZE, { font, tightLines: false });
    assert.deepEqual(Array.from(b), Array.from(a), font);
  }
});

test('tightLines lands the ASCII ink exactly on the packed row', () => {
  const ascii = Array.from({ length: 94 }, (_, i) => String.fromCharCode(0x21 + i)).join('');
  for (const font of ['regular', 'narrow', 'slim'] as const) {
    const style: ExtraKeyTextStyle = { font, tightLines: true, valign: 'top', ellipsis: false };
    const layout = layoutWidget([{ text: ascii, big: false }], 3200, 90, style);
    const [first, last] = inkRows(composeLayout(layout, 3200, 90));
    const f = layout.lines[0]!.font;
    assert.deepEqual([first, last], [0, f.inkHeight - 1], `${font} ink rows`);
  }
});

test('slim scaled rung (64 px, x2) renders and clips at the canvas edge', () => {
  const huge = composeWidgetBmp([{ text: 'W', big: true }], SIZE, SIZE, { ...slim, textSize: 2 });
  assert.ok(inked(huge).length > 100, 'x2 glyph has ink');
  const clipped = composeWidgetBmp([{ text: 'WWWWWW', big: true }], 40, 40, {
    ...slim,
    textSize: 2,
    align: 'left',
  });
  assert.equal(Buffer.from(clipped).readUInt32LE(18), 40);
});

summary();
