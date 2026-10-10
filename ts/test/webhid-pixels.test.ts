import assert from 'tjs:assert';
import { rotateFlip, swapRB, encodeBmp, stripApp2 } from '../src/webhid/pixels.js';
import { gen1BlankImage } from '../src/devices/protocol/elgato-gen1.js';
import { test, summary } from './helpers/harness.js';

const matrix = new Uint8ClampedArray([1, 2, 3, 4, 5, 6].flatMap((n) => [n, 0, 0, 255]));
const expected = {
  0: [1, 2, 3, 4, 5, 6],
  90: [5, 3, 1, 6, 4, 2],
  180: [6, 5, 4, 3, 2, 1],
  270: [2, 4, 6, 1, 3, 5],
};
for (const rotate of [0, 90, 180, 270] as const) {
  for (const flipH of [false, true])
    for (const flipV of [false, true]) {
      test(`rotate ${rotate}, horizontal ${flipH}, vertical ${flipV}`, () => {
        const out = rotateFlip(matrix, 2, 3, rotate, flipH, flipV);
        let rows = Array.from({ length: out.h }, (_, row) =>
          expected[rotate].slice(row * out.w, (row + 1) * out.w),
        );
        if (flipH) rows = rows.map((row) => row.toReversed());
        if (flipV) rows = rows.toReversed();
        assert.equal(
          Array.from(out.rgba).filter((_, i) => i % 4 === 0),
          rows.flat(),
        );
        assert.equal([out.w, out.h], rotate === 90 || rotate === 270 ? [3, 2] : [2, 3]);
      });
    }
}
test('channel swap retains green and alpha', () => {
  const bytes = new Uint8ClampedArray([1, 2, 3, 4]);
  swapRB(bytes);
  assert.equal(Array.from(bytes), [3, 2, 1, 4]);
});
test('Mini BMP has real headers and unchanged blank pixels', () => {
  const blank = gen1BlankImage(80, 80);
  const bmp = encodeBmp(new Uint8ClampedArray(80 * 80 * 4), 80, 80, 2835);
  assert.equal(bmp.length, blank.length);
  assert.equal(Array.from(bmp.subarray(54)), Array.from(blank.subarray(54)));
  const view = new DataView(bmp.buffer);
  assert.equal(Array.from(bmp.subarray(0, 2)), [0x42, 0x4d]);
  assert.equal(view.getUint32(2, true), bmp.length);
  assert.equal(view.getUint32(10, true), 54);
  assert.equal(view.getUint16(28, true), 24);
  assert.equal(view.getInt32(38, true), 2835);
});
test('BMP rows are bottom-up BGR with zero padding', () => {
  const bmp = encodeBmp(new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]), 1, 2);
  assert.equal(Array.from(bmp.subarray(54)), [6, 5, 4, 0, 3, 2, 1, 0]);
});
test('APP2 removal preserves scan bytes and every other segment', () => {
  const bytes = [
    0xff, 0xd8, 0xff, 0xe0, 0, 3, 10, 0xff, 0xe2, 0, 4, 11, 12, 0xff, 0xdb, 0, 3, 13, 0xff, 0xda, 0,
    2, 14, 0xff, 0xe2, 15, 0xff, 0xd9,
  ];
  assert.equal(Array.from(stripApp2(new Uint8Array(bytes))), [
    ...bytes.slice(0, 7),
    ...bytes.slice(13),
  ]);
});
summary();
