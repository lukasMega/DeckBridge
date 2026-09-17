import assert from 'tjs:assert';
import { setupImageHandler } from '../src/image-pipeline.js';
import { EventEmitter } from '../src/platform/events-shim.js';
import type { DeviceDriver, DeviceModel } from '../src/devices/driver.js';
import type { ElgatoChildServer } from '../src/elgato.js';
import type { WebUIServer } from '../src/web/server/index.js';
import { testAsync as test, summaryExit } from './helpers/harness.js';
import { SOLID_RED_16X16_JPEG, makePassthroughModel } from './helpers/fixtures.js';

// Test harness The image pipeline was refactored (architecture-review
// P1): the JPEG/BMP transform + LRU cache + key remap + USB write
// moved OUT of image-pipeline.ts into the worker-side image-render.ts.

// Helpers

interface NotifyCall {
  dock: number;
  keyIndex: number;
  data: Uint8Array;
  format?: string;
}

interface FakeWebUI {
  notifyImageUpdateCalls: NotifyCall[];
  notifyDockImage(dock: number, keyIndex: number, data: Buffer, format?: string): void;
}

function makeFakeWebUI(): FakeWebUI {
  return {
    notifyImageUpdateCalls: [],
    notifyDockImage(dock, keyIndex, data, format) {
      // capture a copy of the bytes at call time
      this.notifyImageUpdateCalls.push({ dock, keyIndex, data: Uint8Array.from(data), format });
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

// Tests

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

// Summary

summaryExit();
