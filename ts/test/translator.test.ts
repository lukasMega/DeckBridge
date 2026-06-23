import assert from 'tjs:assert';
import {
  mk2IndexToDeviceImgId,
  deviceInputToMk2Index,
  transformImageForDevice,
  fillModeFor,
  applyOverride,
} from '../src/translator.js';
import type { DeviceImageSpec } from '../src/devices/driver.js';
import { MIRABOX_293_MODEL } from '../src/devices/mirabox/mirabox-293.js';
import { MIRABOX_K1PRO_MODEL } from '../src/devices/mirabox/mirabox-k1pro.js';

const coraToWireImage = MIRABOX_293_MODEL.keyMap.coraToWireImage!;

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e: unknown) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

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

// A valid 16×16 solid-red JPEG (generated via @julusian/image-rs, verified decodable by Rust sidecar)
const SOLID_RED_16X16_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x02, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x10, 0x03, 0x01, 0x11,
  0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x03, 0x02, 0x02, 0x03,
  0x02, 0x02, 0x03, 0x03, 0x03, 0x03, 0x04, 0x03, 0x03, 0x04, 0x05, 0x08, 0x05, 0x05, 0x04, 0x04,
  0x05, 0x0a, 0x07, 0x07, 0x06, 0x08, 0x0c, 0x0a, 0x0c, 0x0c, 0x0b, 0x0a, 0x0b, 0x0b, 0x0d, 0x0e,
  0x12, 0x10, 0x0d, 0x0e, 0x11, 0x0e, 0x0b, 0x0b, 0x10, 0x16, 0x10, 0x11, 0x13, 0x14, 0x15, 0x15,
  0x15, 0x0c, 0x0f, 0x17, 0x18, 0x16, 0x14, 0x18, 0x12, 0x14, 0x15, 0x14, 0xff, 0xdb, 0x00, 0x43,
  0x01, 0x03, 0x04, 0x04, 0x05, 0x04, 0x05, 0x09, 0x05, 0x05, 0x09, 0x14, 0x0d, 0x0b, 0x0d, 0x14,
  0x14, 0x14, 0x14, 0x14, 0x14, 0x14, 0x14, 0x14, 0x14, 0x14, 0x14, 0x14, 0x14, 0x14, 0x14, 0x14,
  0x14, 0x14, 0x14, 0x14, 0x14, 0x14, 0x14, 0x14, 0x14, 0x14, 0x14, 0x14, 0x14, 0x14, 0x14, 0x14,
  0x14, 0x14, 0x14, 0x14, 0x14, 0x14, 0x14, 0x14, 0x14, 0x14, 0x14, 0x14, 0x14, 0x14, 0x14, 0x14,
  0x14, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09,
  0x0a, 0x0b, 0xff, 0xc4, 0x00, 0xb5, 0x10, 0x00, 0x02, 0x01, 0x03, 0x03, 0x02, 0x04, 0x03, 0x05,
  0x05, 0x04, 0x04, 0x00, 0x00, 0x01, 0x7d, 0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21,
  0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23,
  0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17,
  0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a,
  0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a,
  0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a,
  0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99,
  0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7,
  0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5,
  0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1,
  0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xff, 0xc4, 0x00, 0x1f, 0x01, 0x00, 0x03,
  0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
  0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0xff, 0xc4, 0x00, 0xb5, 0x11, 0x00,
  0x02, 0x01, 0x02, 0x04, 0x04, 0x03, 0x04, 0x07, 0x05, 0x04, 0x04, 0x00, 0x01, 0x02, 0x77, 0x00,
  0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13,
  0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15,
  0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27,
  0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88,
  0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6,
  0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4,
  0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9,
  0xfa, 0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00, 0xf9,
  0xd2, 0xbf, 0x0c, 0x3f, 0xd5, 0x30, 0xa0, 0x02, 0x80, 0x0a, 0x00, 0xff, 0xd9,
]);

// ── Pure mapping tests (no sidecar needed) ───────────────────────────────────

console.log('\ntranslator: index mapping');

await test('mirabox-293 coraToWireImage has 15 entries, all unique, values 1–15', () => {
  assert.equal(coraToWireImage.length, 15);
  const vals = coraToWireImage.toSorted((a, b) => a - b);
  assert.deepEqual(vals, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
});

await test('mk2IndexToDeviceImgId(0, mirabox-293) === 11 (top-left)', () => {
  assert.equal(mk2IndexToDeviceImgId(0, MIRABOX_293_MODEL), 11);
});

await test('mk2IndexToDeviceImgId(4, mirabox-293) === 15 (top-right)', () => {
  assert.equal(mk2IndexToDeviceImgId(4, MIRABOX_293_MODEL), 15);
});

await test('mk2IndexToDeviceImgId(14, mirabox-293) === 5 (bottom-right)', () => {
  assert.equal(mk2IndexToDeviceImgId(14, MIRABOX_293_MODEL), 5);
});

await test('middle row (indices 5–9) maps to i+1', () => {
  for (let i = 5; i <= 9; i++) {
    assert.equal(mk2IndexToDeviceImgId(i, MIRABOX_293_MODEL), i + 1);
  }
});

await test('mk2IndexToDeviceImgId(15, mirabox-293) === -1 (just past 15-entry array)', () => {
  assert.equal(mk2IndexToDeviceImgId(15, MIRABOX_293_MODEL), -1);
});

await test('mk2IndexToDeviceImgId(99, mirabox-293) === -1 (far OOB)', () => {
  assert.equal(mk2IndexToDeviceImgId(99, MIRABOX_293_MODEL), -1);
});

await test('deviceInputToMk2Index(0x01, mirabox-293) === 0', () => {
  assert.equal(deviceInputToMk2Index(0x01, MIRABOX_293_MODEL), 0);
});

await test('deviceInputToMk2Index(0x0F, mirabox-293) === 14', () => {
  assert.equal(deviceInputToMk2Index(0x0f, MIRABOX_293_MODEL), 14);
});

await test('round-trip: all codes 1–15 map to indices 0–14', () => {
  for (let code = 1; code <= 15; code++) {
    const idx = deviceInputToMk2Index(code, MIRABOX_293_MODEL);
    assert.ok(idx >= 0 && idx <= 14);
  }
});

// ── K1 Pro mapping tests ──────────────────────────────────────────────────────

console.log('\ntranslator: mirabox-k1pro index mapping');

await test('mk2IndexToDeviceImgId(0, mirabox-k1pro) === 5 (top-left → device image 5)', () => {
  assert.equal(mk2IndexToDeviceImgId(0, MIRABOX_K1PRO_MODEL), 5);
});

await test('deviceInputToMk2Index(0x05, mirabox-k1pro) === 0', () => {
  assert.equal(deviceInputToMk2Index(0x05, MIRABOX_K1PRO_MODEL), 0);
});

await test('deviceInputToMk2Index(0x01, mirabox-k1pro) === 2', () => {
  assert.equal(deviceInputToMk2Index(0x01, MIRABOX_K1PRO_MODEL), 2);
});

await test('deviceInputToMk2Index(0x25, mirabox-k1pro) === -1 (encoder code dropped)', () => {
  assert.equal(deviceInputToMk2Index(0x25, MIRABOX_K1PRO_MODEL), -1);
});

await test('deviceInputToMk2Index(0x50, mirabox-k1pro) === -1 (encoder code dropped)', () => {
  assert.equal(deviceInputToMk2Index(0x50, MIRABOX_K1PRO_MODEL), -1);
});

// ── fillModeFor mapping ──────────────────────────────────────────────────────

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

// ── applyOverride ────────────────────────────────────────────────────────────

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

// ── Image transform tests (uses Rust sidecar) ────────────────────────────────

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

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
tjs.exit(failed > 0 ? 1 : 0);
