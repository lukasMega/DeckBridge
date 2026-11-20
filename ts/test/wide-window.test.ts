import assert from 'tjs:assert';
import { WideWindowCanvas } from '../src/transform/wide-window.js';
import {
  blitImage,
  canvasSliceToBmp,
  transformImageForDevice,
} from '../src/transform/translator.js';
import { ULANZI_D200_MODEL } from '../src/devices/ulanzi/ulanzi-d200.js';
import type { DeviceImageSpec, DeviceModel } from '../src/devices/driver.js';
import { test, summary } from './helpers/harness.js';
import { SOLID_RED_16X16_JPEG } from './helpers/fixtures.js';

console.log('\nwide-window (D200 info window, Elgato images)');

const WIRE = 13;
const display = ULANZI_D200_MODEL.widgetDisplays![0]!;
// BMP out, so the test can read pixels back.
const MODEL: DeviceModel = {
  ...ULANZI_D200_MODEL,
  widgetDisplays: [{ ...display, image: { ...display.image, format: 'bmp' } }],
};

function fakeDriver() {
  const calls: Array<{ keyIndex: number; bytes: Uint8Array }> = [];
  return {
    calls,
    sendImage: (keyIndex: number, bytes: Uint8Array) => calls.push({ keyIndex, bytes }),
  };
}

/** Red channel at (x, mid-height) of a 24/32-bit BMP, top-down or bottom-up. */
function redAt(bmp: Uint8Array, x: number): number {
  const view = new DataView(bmp.buffer, bmp.byteOffset, bmp.byteLength);
  const offset = view.getUint32(10, true);
  const width = view.getInt32(18, true);
  const height = view.getInt32(22, true);
  const bytes = view.getUint16(28, true) / 8;
  const rowBytes = (width * bytes + 3) & ~3;
  const row = Math.floor(Math.abs(height) / 2);
  return bmp[offset + row * rowBytes + x * bytes + 2]!;
}

test('a source frame is drawn into the window; other keys pass through', () => {
  const canvas = new WideWindowCanvas();
  const d = fakeDriver();
  canvas.configure(WIRE, [13, 14], true);
  assert.equal(canvas.apply(d, MODEL, 5, SOLID_RED_16X16_JPEG), false, 'a normal key');
  assert.equal(canvas.apply(d, MODEL, 13, SOLID_RED_16X16_JPEG), true);
  assert.deepEqual(
    d.calls.map((c) => c.keyIndex),
    [WIRE],
  );
  const bmp = d.calls[0]!.bytes;
  assert.ok(redAt(bmp, 10) > 200, 'key 14 on the left');
  assert.ok(redAt(bmp, 229) < 50, 'black gap in the middle');
  assert.ok(redAt(bmp, 448) < 50, 'key 15 not drawn yet');
  canvas.apply(d, MODEL, 14, SOLID_RED_16X16_JPEG);
  assert.ok(redAt(d.calls[1]!.bytes, 448) > 200, 'both cells side by side');
});

/** Upright 24-bit BMP (w x h) of deterministic non-uniform pixels, rows padded to 4. */
function patternBmp(w: number, h: number, seed: number): Uint8Array {
  const rowBytes = (w * 3 + 3) & ~3;
  const bmp = new Uint8Array(54 + rowBytes * h);
  const v = new DataView(bmp.buffer);
  bmp[0] = 0x42;
  bmp[1] = 0x4d;
  v.setUint32(2, bmp.length, true);
  v.setUint32(10, 54, true);
  v.setUint32(14, 40, true);
  v.setInt32(18, w, true);
  v.setInt32(22, h, true);
  v.setUint16(26, 1, true);
  v.setUint16(28, 24, true);
  for (let r = 0; r < h; r++)
    for (let x = 0; x < w * 3; x++)
      bmp[54 + r * rowBytes + x] = (x * 7 + r * 13 + seed * 61) & 0xff;
  return bmp;
}

/** The pre-optimization compose: blit each cell onto a black canvas, repack to BMP. */
function referenceWindow(model: DeviceModel, cells: Array<[number, Uint8Array]>, center: boolean) {
  const spec = model.widgetDisplays![0]!.image;
  const { width, height } = spec;
  const cell: DeviceImageSpec = {
    ...model.image,
    format: 'bmp',
    width: model.keyWidth,
    height: model.keyHeight,
    maxBytes: 0,
  };
  const canvas = new Uint8Array(width * height * 3);
  const y = Math.floor((height - cell.height) / 2);
  const xs = center ? [Math.floor((width - cell.width) / 2)] : [0, width - cell.width];
  cells.forEach(([, bytes], i) =>
    blitImage(canvas, width, height, transformImageForDevice(bytes, cell), xs[i]!, y),
  );
  return transformImageForDevice(canvasSliceToBmp(canvas, width, height, 0, width), spec);
}

test('window is byte-identical to the canvas blit + repack path (bmp and real D200 output)', () => {
  const frames: Array<[number, Uint8Array]> = [
    [13, patternBmp(100, 77, 1)],
    [14, patternBmp(61, 90, 2)],
  ];
  for (const model of [MODEL, ULANZI_D200_MODEL]) {
    for (const [cellKeys, n] of [
      [[13, 14], 2],
      [[14], 1],
    ] as Array<[number[], number]>) {
      const canvas = new WideWindowCanvas();
      const d = fakeDriver();
      canvas.configure(WIRE, cellKeys, true);
      const used = frames.filter(([k]) => cellKeys.includes(k));
      for (const [k, bytes] of used) canvas.apply(d, model, k, bytes);
      const want = referenceWindow(model, used, n === 1);
      assert.deepEqual(
        Array.from(d.calls.at(-1)!.bytes),
        Array.from(want),
        `${model.widgetDisplays![0]!.image.format} ${cellKeys.length} cell(s)`,
      );
    }
  }
});

test('one source cell is centred', () => {
  const canvas = new WideWindowCanvas();
  const d = fakeDriver();
  canvas.configure(WIRE, [14], true);
  assert.equal(canvas.apply(d, MODEL, 13, SOLID_RED_16X16_JPEG), false, 'not a source now');
  canvas.apply(d, MODEL, 14, SOLID_RED_16X16_JPEG);
  const bmp = d.calls[0]!.bytes;
  assert.ok(redAt(bmp, 229) > 200);
  assert.ok(redAt(bmp, 10) < 50);
});

test('hidden: frames are kept, not drawn; reset forgets the window', () => {
  const canvas = new WideWindowCanvas();
  const d = fakeDriver();
  canvas.configure(WIRE, [13, 14], false);
  assert.equal(canvas.apply(d, MODEL, 13, SOLID_RED_16X16_JPEG), true, 'still taken off key 13');
  assert.deepEqual(d.calls, []);
  canvas.configure(WIRE, [13, 14], true);
  canvas.apply(d, MODEL, 14, SOLID_RED_16X16_JPEG);
  assert.ok(redAt(d.calls[0]!.bytes, 10) > 200, 'the kept frame of key 14 is drawn too');
  canvas.reset();
  assert.equal(canvas.apply(d, MODEL, 13, SOLID_RED_16X16_JPEG), false);
});

summary();
