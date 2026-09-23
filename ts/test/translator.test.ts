import assert from 'tjs:assert';
import {
  transformImageForDevice,
  fillModeFor,
  applyOverride,
  blitImage,
  canvasSliceToBmp,
} from '../src/translator.js';
import type { DeviceImageSpec } from '../src/devices/driver.js';
import { MIRABOX_293_MODEL } from '../src/devices/mirabox/mirabox-293.js';
import { MIRABOX_K1PRO_MODEL } from '../src/devices/mirabox/mirabox-k1pro.js';
import { AJAZZ_AKP05E_MODEL } from '../src/devices/ajazz/akp05e.js';
import { testAsync as test, summaryExit } from './helpers/harness.js';
import { SOLID_RED_16X16_JPEG } from './helpers/fixtures.js';

// Index-mapping tests (mk2IndexToDeviceImgId/deviceInputToMk2Index/deviceInputToExtraKey)
// moved to key-map.test.ts alongside their source (key-map.ts).

// Parse JPEG SOF0/SOF1/SOF2 to extract image dimensions
function getJpegDimensions(jpeg: Uint8Array): { width: number; height: number } | null {
  let i = 0;
  while (i < jpeg.length - 1) {
    if (jpeg[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = jpeg[i + 1]!;
    if (marker === 0xd8) {
      i += 2;
      continue;
    } // SOI
    if (marker === 0xd9) break; // EOI
    if (i + 3 >= jpeg.length) break;
    const segLen = (jpeg[i + 2]! << 8) | jpeg[i + 3]!;
    // SOF0 / SOF1 / SOF2
    if ((marker === 0xc0 || marker === 0xc1 || marker === 0xc2) && segLen >= 7) {
      const height = (jpeg[i + 5]! << 8) | jpeg[i + 6]!;
      const width = (jpeg[i + 7]! << 8) | jpeg[i + 8]!;
      return { width, height };
    }
    i += 2 + segLen;
  }
  return null;
}

// fillModeFor mapping

console.log('\ntranslator: fillModeFor');

function baseImageSpec(overrides: Partial<DeviceImageSpec> = {}): DeviceImageSpec {
  return {
    format: 'jpeg',
    width: 85,
    height: 85,
    rotate: 0,
    flipH: false,
    flipV: false,
    colorMode: 'rgb',
    maxBytes: 5120,
    quality: 0.6,
    transform: 'sidecar',
    ...overrides,
  };
}

await test('fillModeFor: resizeMode resize (default) → 0', () => {
  assert.equal(fillModeFor(baseImageSpec()), 0);
  assert.equal(fillModeFor(baseImageSpec({ resizeMode: 'resize' })), 0);
});

await test('fillModeFor: pad + black → 1', () => {
  assert.equal(fillModeFor(baseImageSpec({ resizeMode: 'pad', padFill: 'black' })), 1);
});

await test('fillModeFor: pad + average → 2', () => {
  assert.equal(fillModeFor(baseImageSpec({ resizeMode: 'pad', padFill: 'average' })), 2);
});

await test('fillModeFor: pad + edge → 3', () => {
  assert.equal(fillModeFor(baseImageSpec({ resizeMode: 'pad', padFill: 'edge' })), 3);
});

await test('fillModeFor: pad + undefined padFill defaults to edge → 3', () => {
  assert.equal(fillModeFor(baseImageSpec({ resizeMode: 'pad' })), 3);
});

await test('fillModeFor: undefined resizeMode → 0', () => {
  assert.equal(fillModeFor(baseImageSpec({ resizeMode: undefined })), 0);
});

// applyOverride

console.log('\ntranslator: applyOverride');

await test('applyOverride: null mode returns spec unchanged', () => {
  const spec = baseImageSpec({ resizeMode: 'pad', padFill: 'edge' });
  assert.equal(applyOverride(spec, null), spec);
});

await test("applyOverride: 'resize' → resizeMode 'resize'", () => {
  const spec = baseImageSpec({ resizeMode: 'pad', padFill: 'edge' });
  const eff = applyOverride(spec, 'resize');
  assert.equal(eff.resizeMode, 'resize');
  assert.equal(eff.padFill, 'edge'); // untouched, ignored when resizeMode !== 'pad'
});

await test("applyOverride: 'pad-black' → pad + black", () => {
  const eff = applyOverride(baseImageSpec(), 'pad-black');
  assert.equal(eff.resizeMode, 'pad');
  assert.equal(eff.padFill, 'black');
});

await test("applyOverride: 'pad-average' → pad + average", () => {
  const eff = applyOverride(baseImageSpec(), 'pad-average');
  assert.equal(eff.resizeMode, 'pad');
  assert.equal(eff.padFill, 'average');
});

await test("applyOverride: 'pad-edge' → pad + edge", () => {
  const eff = applyOverride(baseImageSpec(), 'pad-edge');
  assert.equal(eff.resizeMode, 'pad');
  assert.equal(eff.padFill, 'edge');
});

await test('applyOverride: other spec fields preserved', () => {
  const spec = baseImageSpec({ width: 85, height: 85, quality: 0.6 });
  const eff = applyOverride(spec, 'pad-black');
  assert.equal(eff.width, 85);
  assert.equal(eff.height, 85);
  assert.equal(eff.quality, 0.6);
});

// Image transform tests (uses Rust sidecar)

console.log('\ntranslator: image transform (Rust sidecar)');

await test('transformImageForDevice (mirabox-293) output is a valid JPEG', () => {
  const out = transformImageForDevice(SOLID_RED_16X16_JPEG, MIRABOX_293_MODEL.image);
  assert.equal(out[0], 0xff);
  assert.equal(out[1], 0xd8);
});

await test('transformImageForDevice (mirabox-293) output is ≤ maxBytes', () => {
  const out = transformImageForDevice(SOLID_RED_16X16_JPEG, MIRABOX_293_MODEL.image);
  assert.ok(out.length <= MIRABOX_293_MODEL.image.maxBytes);
});

await test('transformImageForDevice (mirabox-293) output decodes to spec width×height', () => {
  const out = transformImageForDevice(SOLID_RED_16X16_JPEG, MIRABOX_293_MODEL.image);
  const dims = getJpegDimensions(out);
  assert.notEqual(dims, null);
  assert.equal(dims!.width, MIRABOX_293_MODEL.image.width);
  assert.equal(dims!.height, MIRABOX_293_MODEL.image.height);
});

await test('transformImageForDevice (400x400 BMP) grows OUT past 256 KB and returns full buffer', () => {
  const spec = {
    format: 'bmp' as const,
    width: 400,
    height: 400,
    rotate: 0 as const,
    flipH: false,
    flipV: false,
    colorMode: 'rgb' as const,
    maxBytes: 0,
    quality: 0.85,
    transform: 'sidecar' as const,
  };
  const out = transformImageForDevice(SOLID_RED_16X16_JPEG, spec);
  // 54-byte BMP header + 400*400*3 bytes of pixel data = 480054, well over the
  // 256 KB initial OUT scratch buffer — exercises the -2 grow-and-retry path.
  assert.equal(out.length, 480054);
  assert.equal(out[0], 0x42); // 'B'
  assert.equal(out[1], 0x4d); // 'M'
});

await test('mirabox-k1pro spec carries crop: 6', () => {
  assert.equal(MIRABOX_K1PRO_MODEL.image.crop, 6);
});

await test('transformImageForDevice (mirabox-k1pro, crop:6) decodes to 64×64', () => {
  const out = transformImageForDevice(SOLID_RED_16X16_JPEG, MIRABOX_K1PRO_MODEL.image);
  assert.equal(out[0], 0xff);
  assert.equal(out[1], 0xd8);
  const dims = getJpegDimensions(out);
  assert.notEqual(dims, null);
  assert.equal(dims!.width, 64);
  assert.equal(dims!.height, 64);
});

await test('crop that exceeds the source is ignored (no panic), output still valid', () => {
  // 16×16 source, crop 10 → would leave -4 px; the guard skips the crop.
  const spec = baseImageSpec({ width: 32, height: 32, crop: 10 });
  const out = transformImageForDevice(SOLID_RED_16X16_JPEG, spec);
  const dims = getJpegDimensions(out);
  assert.equal(dims!.width, 32);
  assert.equal(dims!.height, 32);
});

await test('crop within bounds applies, then resizes to spec size', () => {
  // 16×16 source, crop 4 → 8×8, then resize to 32×32 — exercises the crop branch.
  const spec = baseImageSpec({ width: 32, height: 32, crop: 4 });
  const out = transformImageForDevice(SOLID_RED_16X16_JPEG, spec);
  const dims = getJpegDimensions(out);
  assert.equal(dims!.width, 32);
  assert.equal(dims!.height, 32);
});

// Touch-strip canvas (Stream Deck + window partial updates)

console.log('\ntranslator: touch-strip canvas');

await test('blitImage draws a patch at its offset and leaves the rest of the canvas', () => {
  const cw = 40;
  const canvas = new Uint8Array(cw * 20 * 3);
  blitImage(canvas, cw, 20, SOLID_RED_16X16_JPEG, 8, 2);
  const px = (x: number, y: number): number[] => [
    ...canvas.subarray((y * cw + x) * 3, (y * cw + x) * 3 + 3),
  ];
  const [r, g, b] = px(10, 5);
  assert.ok(r! > 200 && g! < 60 && b! < 60, `patch is red (got ${r},${g},${b})`);
  assert.deepEqual(px(0, 0), [0, 0, 0]);
  assert.deepEqual(px(30, 5), [0, 0, 0]);
});

await test('blitImage rejects undecodable input', () => {
  assert.throws(() => blitImage(new Uint8Array(12), 4, 1, new Uint8Array([1, 2, 3]), 0, 0));
});

await test('canvasSliceToBmp: bottom-up BGR rows, padded to 4 bytes', () => {
  // 3×2 canvas, slice x=1 w=1: rows hold (1,2,3) on top, (4,5,6) below.
  const canvas = new Uint8Array([0, 0, 0, 1, 2, 3, 0, 0, 0, 0, 0, 0, 4, 5, 6, 0, 0, 0]);
  const bmp = canvasSliceToBmp(canvas, 3, 2, 1, 1);
  const view = new DataView(bmp.buffer);
  assert.equal(bmp.length, 54 + 4 * 2, '3-byte rows padded to 4');
  assert.equal(view.getInt32(18, true), 1);
  assert.equal(view.getInt32(22, true), 2);
  assert.deepEqual([...bmp.subarray(54, 57)], [6, 5, 4], 'bottom row first, BGR');
  assert.deepEqual([...bmp.subarray(58, 61)], [3, 2, 1]);
});

await test('a canvas slice goes through the device transform', () => {
  const canvas = new Uint8Array(800 * 100 * 3);
  blitImage(canvas, 800, 100, SOLID_RED_16X16_JPEG, 210, 10);
  const out = transformImageForDevice(
    canvasSliceToBmp(canvas, 800, 100, 200, 200),
    AJAZZ_AKP05E_MODEL.widgetDisplays![1]!.image,
  );
  assert.ok(out.length > 0);
});

// Summary

summaryExit();
