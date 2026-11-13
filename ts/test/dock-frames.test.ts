import assert from 'tjs:assert';
import { LastFrames, wireDockImages } from '../src/main/dock-frames.js';
import { EventEmitter } from '../src/platform/events-shim.js';
import type { DockDriver, DeviceModel } from '../src/devices/driver.js';
import { hashJpeg } from '../src/shared/image-hash.js';
import { MockDriver } from '../src/devices/mock.js';
import { StubDockDriver } from './helpers/stub-dock-driver.js';
import type { ElgatoChildServer } from '../src/cora/child-server.js';
import { testAsync as test, summaryExit } from './helpers/harness.js';
import { SOLID_RED_16X16_JPEG, makePassthroughModel } from './helpers/fixtures.js';

// The JPEG/BMP transform + LRU cache + key remap + USB write live in the
// worker-side image-render.ts; the main thread only forwards, records, mirrors.

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

/** Records renderCoraImage (the WorkerHidDriver shape). */
class FakeDriver extends StubDockDriver {
  renderCoraImageCalls: RenderCall[] = [];
  override renderCoraImage(keyIndex: number, coraBytes: Uint8Array, format: 'jpeg' | 'bmp') {
    this.renderCoraImageCalls.push({ keyIndex, bytes: coraBytes, format });
  }
}

const makeFakeDriver = (model: DeviceModel): FakeDriver => new FakeDriver(model);

/** The virtual deck: its renderCoraImage is a no-op. */
const makeFakeMockDriver = (model: DeviceModel): DockDriver => new MockDriver(model);

// Tests

/** wireDockImages with the WebUI mirror as the onImage sink. */
function setupImageHandler(
  childServer: EventEmitter,
  webui: Pick<FakeWebUI, 'notifyDockImage'>,
  getDriver: () => DockDriver | null,
  frames = new LastFrames(),
): LastFrames {
  wireDockImages(childServer as unknown as ElgatoChildServer, {
    driver: getDriver,
    frames,
    onImage: (key, data, format) => webui.notifyDockImage(0, key, data, format),
  });
  return frames;
}

console.log('\ndock-frames: wireDockImages (thin handler, P1)');

// 1a. notifyImageUpdate fires SYNCHRONOUSLY during emit (jpeg).
await test('notifyImageUpdate is called synchronously during emit (jpeg)', () => {
  const childServer = new EventEmitter();
  const model = makePassthroughModel();
  const driver = makeFakeDriver(model);
  const webui = makeFakeWebUI();

  setupImageHandler(childServer, webui, () => driver);

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

  setupImageHandler(childServer, webui, () => driver);

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

  setupImageHandler(childServer, webui, () => driver);

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
await test('the mock driver (no-op renderCoraImage) does not throw', () => {
  const childServer = new EventEmitter();
  const model = makePassthroughModel();
  const mockDriver = makeFakeMockDriver(model);
  const webui = makeFakeWebUI();

  setupImageHandler(childServer, webui, () => mockDriver);

  // Must not throw despite the driver lacking renderCoraImage.
  childServer.emit('image', {
    keyIndex: 2,
    data: SOLID_RED_16X16_JPEG,
    format: 'jpeg',
  });

  assert.equal(
    webui.notifyImageUpdateCalls.length,
    1,
    'notifyImageUpdate still fires for the mock',
  );
  assert.equal(webui.notifyImageUpdateCalls[0]!.keyIndex, 2, 'keyIndex should be 2');
});

await test('the mock driver emits frameHash for each rendered image', () => {
  const childServer = new EventEmitter();
  const mockDriver = makeFakeMockDriver(makePassthroughModel());
  const seen: [number, string][] = [];
  mockDriver.on('frameHash', (key: number, hash: string) => seen.push([key, hash]));
  setupImageHandler(childServer, makeFakeWebUI(), () => mockDriver);
  childServer.emit('image', { keyIndex: 2, data: SOLID_RED_16X16_JPEG, format: 'jpeg' });
  assert.deepEqual(seen, [[2, hashJpeg(SOLID_RED_16X16_JPEG)]]);
});

// 4. getDriver() returning null does NOT throw; webui still fires.
await test('null driver does not throw and notifyImageUpdate still fires', () => {
  const childServer = new EventEmitter();
  const webui = makeFakeWebUI();

  setupImageHandler(childServer, webui, () => null);

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

// 5. USB worker is posted before the WebUI mirror (B2 fix — latency first).
await test('renderCoraImage fires before notifyDockImage', () => {
  const childServer = new EventEmitter();
  const model = makePassthroughModel();
  const order: string[] = [];

  const driver = new StubDockDriver(model);
  driver.renderCoraImage = () => {
    order.push('worker');
  };

  const webui = {
    notifyDockImage: (_dock: number, _keyIndex: number, _data: Buffer, _format?: string) => {
      order.push('webui');
    },
  };

  setupImageHandler(childServer, webui, () => driver);

  childServer.emit('image', {
    keyIndex: 3,
    data: SOLID_RED_16X16_JPEG,
    format: 'jpeg',
  });

  assert.deepEqual(
    order,
    ['worker', 'webui'],
    'USB worker post must happen before the WebUI mirror',
  );
});

// 6. Frames are recorded only while a driver is attached.
await test('frames are recorded only while a driver is attached', () => {
  const childServer = new EventEmitter();
  const model = makePassthroughModel();
  const driver = makeFakeDriver(model);
  let attached: FakeDriver | null = null;
  const frames = setupImageHandler(childServer, makeFakeWebUI(), () => attached);

  childServer.emit('image', { keyIndex: 1, data: SOLID_RED_16X16_JPEG, format: 'jpeg' });
  attached = driver;
  frames.replay(driver); // what a dock does on attach
  childServer.emit('image', { keyIndex: 2, data: SOLID_RED_16X16_JPEG, format: 'jpeg' });

  const replayed = makeFakeDriver(model);
  frames.replay(replayed);
  assert.deepEqual(
    replayed.renderCoraImageCalls.map((c) => c.keyIndex),
    [2],
    'only the frame painted on a device is replayable',
  );
});

// 7. LastFrames: replay only onto the same model; repaint re-renders all.
await test('LastFrames replays onto the same model, drops frames for a different one', () => {
  const model = makePassthroughModel();
  const frames = new LastFrames();
  frames.replay(makeFakeDriver(model)); // first attach: nothing to replay, binds the model
  frames.record(0, Buffer.from([1]), 'jpeg');
  frames.record(3, Buffer.from([2]), 'bmp');

  const again = makeFakeDriver(model);
  const mirrored: number[] = [];
  frames.replay(again, (key) => mirrored.push(key));
  assert.deepEqual(
    again.renderCoraImageCalls.map((c) => c.keyIndex),
    [0, 3],
    'same model: replayed',
  );
  assert.deepEqual(mirrored, [0, 3], 'preview restored');

  const repainted = makeFakeDriver(model);
  frames.repaint(repainted);
  assert.equal(repainted.renderCoraImageCalls.length, 2, 'repaint re-renders every frame');

  const other = makeFakeDriver({ ...model, id: 'other-model' });
  frames.replay(other);
  assert.equal(other.renderCoraImageCalls.length, 0, 'a different model inherits nothing');
  frames.repaint(repainted);
  assert.equal(repainted.renderCoraImageCalls.length, 2, 'and the frames are gone');
});

await test('repaint mirrors each frame, and has() reports recorded keys', () => {
  const frames = new LastFrames();
  const driver = makeFakeDriver(makePassthroughModel());
  frames.record(1, Buffer.from([1]), 'jpeg');
  frames.record(4, Buffer.from([2]), 'bmp');
  assert.ok(frames.has(1) && frames.has(4), 'recorded');
  assert.ok(!frames.has(0), 'not recorded');
  const mirrored: string[] = [];
  frames.repaint(driver, (key, _data, format) => mirrored.push(`${key}:${format}`));
  assert.deepEqual(mirrored, ['1:jpeg', '4:bmp']);
  assert.equal(driver.renderCoraImageCalls.length, 2);
  frames.repaint(driver); // the mirror stays optional
  assert.equal(driver.renderCoraImageCalls.length, 4);
});

await test('onAppFrame fires for an image and a touchImage, after the driver and mirror', () => {
  const childServer = new EventEmitter();
  const driver = makeFakeDriver(makePassthroughModel());
  const order: string[] = [];
  wireDockImages(childServer as unknown as ElgatoChildServer, {
    driver: () => driver,
    frames: new LastFrames(),
    onImage: () => void order.push('mirror'),
    onTouchImage: () => void order.push('touchMirror'),
    onAppFrame: () => void order.push(`frame@${driver.renderCoraImageCalls.length}`),
  });
  childServer.emit('image', { keyIndex: 2, data: SOLID_RED_16X16_JPEG, format: 'jpeg' });
  childServer.emit('touchImage', { data: new Uint8Array([1]) });
  assert.deepEqual(order, ['mirror', 'frame@1', 'touchMirror', 'frame@1']);
});

// Summary

summaryExit();
