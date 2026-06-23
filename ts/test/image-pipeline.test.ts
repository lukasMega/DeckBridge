import assert from 'tjs:assert';
import { setupImageHandler } from '../src/image-pipeline.js';
import { EventEmitter } from '../src/platform/events-shim.js';
import type { DeviceDriver, DeviceModel } from '../src/devices/driver.js';
import type { ElgatoChildServer } from '../src/elgato.js';
import type { WebUIServer } from '../src/web/server/index.js';

// ── Test harness ─────────────────────────────────────────────────────────────
//
// The image pipeline was refactored (architecture-review P1): the JPEG/BMP
// transform + LRU cache + key remap + USB write moved OUT of image-pipeline.ts
// into the worker-side image-render.ts. image-pipeline.ts is now THIN — on each
// childServer 'image' event it does exactly two things, SYNCHRONOUSLY:
//   1. webui.notifyImageUpdate(keyIndex, Buffer.from(data), format)
//   2. getDriver()?.renderCoraImage?.(keyIndex, data, format)   // raw bytes
// No transform, no cache, no sendImage, no notifyStats on this path.

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

// ── A valid 16x16 solid-red JPEG (same fixture as translator.test.ts) ─────────
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

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal DeviceModel — only enough to satisfy the driver shape. The thin
 *  handler never reads model.image, so the values are placeholders. */
function makePassthroughModel(): DeviceModel {
  return {
    id: 'test-passthrough',
    vendor: 'elgato',
    protocol: 'elgato-gen2',
    name: 'Test Passthrough Device',
    usbVendorId: 0x0fd9,
    usbProductIds: [0x00a5],
    keyCount: 15,
    columns: 5,
    rows: 3,
    keyWidth: 96,
    keyHeight: 96,
    image: {
      format: 'jpeg',
      width: 96,
      height: 96,
      rotate: 0,
      flipH: false,
      flipV: false,
      colorMode: 'rgb',
      maxBytes: 0,
      quality: 0.9,
      transform: 'passthrough',
    },
    keyMap: {},
    cora: {
      productId: 0x00a5,
      usePhysicalIdentity: true,
    },
    driverKind: 'elgato-hid',
  };
}

interface NotifyCall {
  keyIndex: number;
  data: Uint8Array;
  format?: string;
}

interface FakeWebUI {
  notifyImageUpdateCalls: NotifyCall[];
  notifyImageUpdate(keyIndex: number, data: Buffer, format?: string): void;
}

function makeFakeWebUI(): FakeWebUI {
  return {
    notifyImageUpdateCalls: [],
    notifyImageUpdate(keyIndex, data, format) {
      // capture a copy of the bytes at call time
      this.notifyImageUpdateCalls.push({ keyIndex, data: Uint8Array.from(data), format });
    },
  };
}

interface RenderCall {
  keyIndex: number;
  bytes: Uint8Array;
  format: 'jpeg' | 'bmp';
}

interface FakeDriver extends EventEmitter {
  model: DeviceModel;
  renderCoraImageCalls: RenderCall[];
  renderCoraImage(keyIndex: number, coraBytes: Uint8Array, format: 'jpeg' | 'bmp'): void;
  sendImage(keyIndex: number, bytes: Uint8Array): void;
  open(): Promise<void>;
  close(): Promise<void>;
  clearKey(keyIndex: number): void;
  setBrightness(level: number): void;
}

/** Fake driver WITH a renderCoraImage capture (the real WorkerHidDriver shape). */
function makeFakeDriver(model: DeviceModel): FakeDriver {
  const ee = new EventEmitter();
  return Object.assign(ee, {
    model,
    renderCoraImageCalls: [] as RenderCall[],
    renderCoraImage(keyIndex: number, coraBytes: Uint8Array, format: 'jpeg' | 'bmp') {
      this.renderCoraImageCalls.push({ keyIndex, bytes: coraBytes, format });
    },
    sendImage: (_keyIndex: number, _bytes: Uint8Array) => {},
    open: () => Promise.resolve(),
    close: () => Promise.resolve(),
    clearKey: (_keyIndex: number) => {},
    setBrightness: (_level: number) => {},
  });
}

/** Fake driver WITHOUT renderCoraImage (the MockDriver shape — virtual device). */
function makeFakeMockDriver(model: DeviceModel): DeviceDriver {
  const ee = new EventEmitter();
  return Object.assign(ee, {
    model,
    sendImage: (_keyIndex: number, _bytes: Uint8Array) => {},
    open: () => Promise.resolve(),
    close: () => Promise.resolve(),
    clearKey: (_keyIndex: number) => {},
    setBrightness: (_level: number) => {},
  }) as DeviceDriver;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log('\nimage-pipeline: setupImageHandler (thin handler, P1)');

// 1a. notifyImageUpdate fires SYNCHRONOUSLY during emit (jpeg).
await test('notifyImageUpdate is called synchronously during emit (jpeg)', () => {
  const childServer = new EventEmitter();
  const model = makePassthroughModel();
  const driver = makeFakeDriver(model);
  const webui = makeFakeWebUI();

  setupImageHandler(
    childServer as unknown as ElgatoChildServer,
    webui as unknown as WebUIServer,
    () => driver,
  );

  childServer.emit('image', {
    keyIndex: 4,
    data: SOLID_RED_16X16_JPEG,
    format: 'jpeg',
  });

  // No await — must already be recorded right after emit() returns.
  assert.equal(
    webui.notifyImageUpdateCalls.length,
    1,
    'notifyImageUpdate should fire synchronously during emit',
  );
  const call = webui.notifyImageUpdateCalls[0]!;
  assert.equal(call.keyIndex, 4, 'keyIndex should be 4');
  assert.equal(call.format, 'jpeg', 'format should be jpeg');
});

// 1b. notifyImageUpdate fires SYNCHRONOUSLY during emit (bmp).
await test('notifyImageUpdate is called synchronously during emit (bmp)', () => {
  const childServer = new EventEmitter();
  const model = makePassthroughModel();
  const driver = makeFakeDriver(model);
  const webui = makeFakeWebUI();

  setupImageHandler(
    childServer as unknown as ElgatoChildServer,
    webui as unknown as WebUIServer,
    () => driver,
  );

  const bmpData = Buffer.from([0x42, 0x4d, 0xaa, 0xbb, 0xcc, 0xdd]);
  childServer.emit('image', { keyIndex: 9, data: bmpData, format: 'bmp' });

  assert.equal(
    webui.notifyImageUpdateCalls.length,
    1,
    'notifyImageUpdate should fire synchronously during emit',
  );
  const call = webui.notifyImageUpdateCalls[0]!;
  assert.equal(call.keyIndex, 9, 'keyIndex should be 9');
  assert.equal(call.format, 'bmp', 'format should be bmp');
});

// 2. renderCoraImage receives (keyIndex, data, format) with the RAW bytes.
await test('renderCoraImage receives keyIndex, raw bytes, and format', () => {
  const childServer = new EventEmitter();
  const model = makePassthroughModel();
  const driver = makeFakeDriver(model);
  const webui = makeFakeWebUI();

  setupImageHandler(
    childServer as unknown as ElgatoChildServer,
    webui as unknown as WebUIServer,
    () => driver,
  );

  childServer.emit('image', {
    keyIndex: 6,
    data: SOLID_RED_16X16_JPEG,
    format: 'jpeg',
  });

  // Synchronous forward — should already be recorded.
  assert.equal(driver.renderCoraImageCalls.length, 1, 'renderCoraImage should be called once');
  const call = driver.renderCoraImageCalls[0]!;
  assert.equal(call.keyIndex, 6, 'keyIndex should be 6 (NOT remapped here)');
  assert.equal(call.format, 'jpeg', 'format should be jpeg');
  // The bytes must be the RAW emitted bytes, byte-for-byte (no transform).
  assert.deepEqual(
    Array.from(call.bytes),
    Array.from(SOLID_RED_16X16_JPEG),
    'renderCoraImage should receive the raw, untransformed CORA bytes',
  );
});

// 3. Driver WITHOUT renderCoraImage (MockDriver) does NOT throw; webui still fires.
await test('driver without renderCoraImage does not throw (MockDriver)', () => {
  const childServer = new EventEmitter();
  const model = makePassthroughModel();
  const mockDriver = makeFakeMockDriver(model);
  const webui = makeFakeWebUI();

  setupImageHandler(
    childServer as unknown as ElgatoChildServer,
    webui as unknown as WebUIServer,
    () => mockDriver,
  );

  // Must not throw despite the driver lacking renderCoraImage.
  childServer.emit('image', {
    keyIndex: 2,
    data: SOLID_RED_16X16_JPEG,
    format: 'jpeg',
  });

  assert.equal(
    webui.notifyImageUpdateCalls.length,
    1,
    'notifyImageUpdate should still fire when driver lacks renderCoraImage',
  );
  assert.equal(webui.notifyImageUpdateCalls[0]!.keyIndex, 2, 'keyIndex should be 2');
});

// 4. getDriver() returning null does NOT throw; webui still fires.
await test('null driver does not throw and notifyImageUpdate still fires', () => {
  const childServer = new EventEmitter();
  const webui = makeFakeWebUI();

  setupImageHandler(
    childServer as unknown as ElgatoChildServer,
    webui as unknown as WebUIServer,
    () => null,
  );

  // Must not throw despite a null driver.
  childServer.emit('image', {
    keyIndex: 1,
    data: SOLID_RED_16X16_JPEG,
    format: 'jpeg',
  });

  assert.equal(
    webui.notifyImageUpdateCalls.length,
    1,
    'notifyImageUpdate should still fire when getDriver() returns null',
  );
  assert.equal(webui.notifyImageUpdateCalls[0]!.keyIndex, 1, 'keyIndex should be 1');
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
tjs.exit(failed > 0 ? 1 : 0);
