import assert from 'tjs:assert';
import { renderImage, TouchStripCanvas } from '../src/image-render.js';
import { blitImage, canvasSliceToBmp } from '../src/translator.js';
import { AJAZZ_AKP05E_MODEL } from '../src/devices/ajazz/akp05e.js';
import { MIRABOX_293_MODEL } from '../src/devices/mirabox/mirabox-293.js';
import { testAsync as test, summaryExit } from './helpers/harness.js';
import { SOLID_RED_16X16_JPEG, makePassthroughModel } from './helpers/fixtures.js';

const coraToWireImage = MIRABOX_293_MODEL.keyMap.coraToWireImage!;

// Fake driver (records every sendImage call)

type SendImageCall = { keyIndex: number; bytes: Uint8Array };

function makeFakeDriver(): {
  calls: SendImageCall[];
  sendImage(keyIndex: number, bytes: Uint8Array): void;
} {
  return {
    calls: [] as SendImageCall[],
    sendImage(keyIndex: number, bytes: Uint8Array) {
      this.calls.push({ keyIndex, bytes });
    },
  };
}

// renderImage tests (uses the real Rust image-proc
// FFI transform) NOTE: `imageCache` is a module
// singleton shared across every case in this file.

console.log('\nimage-render: renderImage (Rust sidecar)');

// 1. sidecar model produces a valid JPEG ≤ maxBytes.
await test('sidecar model produces a valid JPEG ≤ maxBytes', () => {
  const fake = makeFakeDriver();
  renderImage(fake, MIRABOX_293_MODEL, 0, SOLID_RED_16X16_JPEG, 'jpeg');

  assert.equal(fake.calls.length, 1, 'sendImage should be called once');
  const bytes = fake.calls[0]!.bytes;
  assert.equal(bytes[0], 0xff, 'first byte must be 0xff (JPEG SOI)');
  assert.equal(bytes[1], 0xd8, 'second byte must be 0xd8 (JPEG SOI)');
  assert.ok(
    bytes.length <= MIRABOX_293_MODEL.image.maxBytes,
    `output (${bytes.length}) must be ≤ maxBytes (${MIRABOX_293_MODEL.image.maxBytes})`,
  );
});

// 2. cache hit returns identical bytes (transform runs once).
// Uses a distinct source image (one mutated byte deep in the entropy-coded
// scan) so it cannot collide with case 1/3's cache entry.
await test('second identical image is a cache hit (same bytes)', () => {
  const distinct = Buffer.from(SOLID_RED_16X16_JPEG);
  distinct[distinct.length - 5] = (distinct[distinct.length - 5]! ^ 0x55) & 0xff;
  const fake = makeFakeDriver();

  renderImage(fake, MIRABOX_293_MODEL, 1, distinct, 'jpeg');
  assert.equal(fake.calls.length, 1, 'first render should call sendImage once');
  const firstBytes = fake.calls[0]!.bytes;

  renderImage(fake, MIRABOX_293_MODEL, 1, distinct, 'jpeg');
  assert.equal(fake.calls.length, 2, 'second render should call sendImage again');
  const secondBytes = fake.calls[1]!.bytes;

  assert.deepEqual(
    Array.from(secondBytes),
    Array.from(firstBytes),
    'cache hit must yield byte-identical output to the first transform',
  );
});

// 3. key remap: sendImage keyIndex equals coraToWireImage[0] (NOT 0).
await test('key remap: sendImage receives mapped device key index', () => {
  const fake = makeFakeDriver();
  renderImage(fake, MIRABOX_293_MODEL, 0, SOLID_RED_16X16_JPEG, 'jpeg');

  assert.equal(fake.calls.length, 1, 'sendImage should be called once');
  assert.equal(
    fake.calls[0]!.keyIndex,
    coraToWireImage[0],
    `sendImage keyIndex should be coraToWireImage[0] (${coraToWireImage[0]}), not 0`,
  );
});

// 4. out-of-range key (coraToWireImage[99] === undefined → -1) is skipped.
await test('out-of-range key is skipped (no sendImage)', () => {
  const fake = makeFakeDriver();
  renderImage(fake, MIRABOX_293_MODEL, 99, SOLID_RED_16X16_JPEG, 'jpeg');

  assert.equal(
    fake.calls.length,
    0,
    'sendImage must not be called when the mapped device key index is < 0',
  );
});

// 5. passthrough model forwards original bytes unchanged (no transform).
await test('passthrough model forwards original bytes unchanged', () => {
  const model = makePassthroughModel();
  const fake = makeFakeDriver();
  // Distinct bytes that begin like a JPEG but are not a real image — proves no
  // transform ran (a transform would reject/alter these).
  const someBytes = Buffer.from([0xff, 0xd8, 0x11, 0x22, 0x33, 0x44, 0x55, 0xff, 0xd9]);

  renderImage(fake, model, 1, someBytes, 'jpeg');

  assert.equal(fake.calls.length, 1, 'sendImage should be called once');
  const call = fake.calls[0]!;
  assert.equal(call.keyIndex, 1, 'identity key map → device key index 1');
  assert.deepEqual(
    Array.from(call.bytes),
    Array.from(someBytes),
    'passthrough must forward the input bytes unchanged',
  );
});

console.log('\nimage-render: TouchStripCanvas');

const STRIP = AJAZZ_AKP05E_MODEL.touchStripDisplay!;
const SLOTS = AJAZZ_AKP05E_MODEL.widgetDisplays!;

/** SOF0 frame size of a baseline JPEG. */
function jpegSize(jpeg: Uint8Array): { width: number; height: number } {
  for (let i = 0; i < jpeg.length - 8; i++) {
    if (jpeg[i] === 0xff && jpeg[i + 1] === 0xc0) {
      return {
        height: (jpeg[i + 5]! << 8) | jpeg[i + 6]!,
        width: (jpeg[i + 7]! << 8) | jpeg[i + 8]!,
      };
    }
  }
  throw new Error('no SOF0 marker');
}

/** An 800×100 BMP of random pixels — the worst case for the JPEG byte cap. */
function noisyStripBmp(): Uint8Array {
  const rgb = new Uint8Array(800 * 100 * 3);
  let seed = 1;
  for (let i = 0; i < rgb.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    rgb[i] = seed >> 16;
  }
  return canvasSliceToBmp(rgb, 800, 100, 0, 800);
}

/** Red pixels in a device JPEG (decoded through the same blit the canvas uses). */
function redPixels(jpeg: Uint8Array): number {
  const { width, height } = jpegSize(jpeg);
  const rgb = new Uint8Array(width * height * 3);
  blitImage(rgb, width, height, jpeg, 0, 0);
  let red = 0;
  for (let o = 0; o < rgb.length; o += 3) if (rgb[o]! > 128 && rgb[o + 1]! < 80) red++;
  return red;
}

await test('a full window is one wire-1 upload, 800×112, within the byte cap', () => {
  const driver = makeFakeDriver();
  new TouchStripCanvas().apply(driver, AJAZZ_AKP05E_MODEL, noisyStripBmp());
  assert.deepEqual(
    driver.calls.map((c) => c.keyIndex),
    [STRIP.wireId],
  );
  const jpeg = driver.calls[0]!.bytes;
  assert.deepEqual(jpegSize(jpeg), { width: 800, height: 112 });
  assert.ok(jpeg.length <= 10_100, `${jpeg.length} B fits the 10 100 B firmware cap`);
});

await test('a region covering the whole window is a full-strip upload too', () => {
  const driver = makeFakeDriver();
  new TouchStripCanvas().apply(driver, AJAZZ_AKP05E_MODEL, SOLID_RED_16X16_JPEG, {
    x: 0,
    y: 0,
    w: 800,
    h: 100,
  });
  assert.equal(driver.calls.length, 1);
  assert.equal(jpegSize(driver.calls[0]!.bytes).width, 800);
});

await test('a partial window re-sends only the slots it touches, each 176×112', () => {
  const canvas = new TouchStripCanvas();
  const driver = makeFakeDriver();
  const patch = (x: number): void =>
    canvas.apply(driver, AJAZZ_AKP05E_MODEL, SOLID_RED_16X16_JPEG, { x, y: 40, w: 16, h: 16 });
  patch(416);
  patch(192); // straddles zones 1 and 2
  assert.deepEqual(
    driver.calls.map((c) => c.keyIndex),
    [SLOTS[2]!.wireId, SLOTS[0]!.wireId, SLOTS[1]!.wireId],
  );
  for (const call of driver.calls) {
    assert.deepEqual(jpegSize(call.bytes), { width: 176, height: 112 });
  }
});

await test("'always' sends every patch as a full-strip upload", () => {
  const canvas = new TouchStripCanvas();
  canvas.setOptions({ zoneFit: 'crop', upload: 'always' });
  const driver = makeFakeDriver();
  canvas.apply(driver, AJAZZ_AKP05E_MODEL, SOLID_RED_16X16_JPEG, { x: 416, y: 40, w: 16, h: 16 });
  assert.deepEqual(
    driver.calls.map((c) => [c.keyIndex, jpegSize(c.bytes).width]),
    [[STRIP.wireId, 800]],
  );
});

await test('a masked zone turns a full window into per-slot uploads of the rest', () => {
  const canvas = new TouchStripCanvas();
  const driver = makeFakeDriver();
  canvas.setMask(driver, AJAZZ_AKP05E_MODEL, [SLOTS[1]!.wireId]);
  canvas.apply(driver, AJAZZ_AKP05E_MODEL, SOLID_RED_16X16_JPEG);
  assert.deepEqual(
    driver.calls.map((c) => c.keyIndex),
    [SLOTS[0]!.wireId, SLOTS[2]!.wireId, SLOTS[3]!.wireId],
  );
});

await test("'crop' shows the slot window's own pixels; 'scale' shows the whole zone", () => {
  // A 16-px red patch at `x`; the first upload is the leftmost slot it touches.
  const redIn = (zoneFit: 'crop' | 'scale', x: number): number => {
    const canvas = new TouchStripCanvas();
    canvas.setOptions({ zoneFit, upload: 'full-frames' });
    const driver = makeFakeDriver();
    canvas.apply(driver, AJAZZ_AKP05E_MODEL, SOLID_RED_16X16_JPEG, { x, y: 40, w: 16, h: 16 });
    return redPixels(driver.calls[0]!.bytes);
  };
  assert.equal(redIn('crop', 190), 0, 'x 190–205 is zone 1 and gap only: slot 1 ends at 176');
  assert.ok(redIn('scale', 184) > 0, 'scale keeps zone 1 x 184–199');
  assert.ok(redIn('crop', 203) > 0, 'crop shows slot 2 x 203+');
});

await test('restoring every zone is one full-strip upload; fewer go per slot', () => {
  const canvas = new TouchStripCanvas();
  const driver = makeFakeDriver();
  canvas.restore(
    driver,
    AJAZZ_AKP05E_MODEL,
    SLOTS.map((d) => d.wireId),
  );
  canvas.restore(driver, AJAZZ_AKP05E_MODEL, [SLOTS[3]!.wireId]);
  assert.deepEqual(
    driver.calls.map((c) => [c.keyIndex, jpegSize(c.bytes).width]),
    [
      [STRIP.wireId, 800],
      [SLOTS[3]!.wireId, 176],
    ],
  );
});

await test('an undecodable window sends nothing', () => {
  const driver = makeFakeDriver();
  new TouchStripCanvas().apply(driver, AJAZZ_AKP05E_MODEL, new Uint8Array([1, 2, 3]));
  assert.equal(driver.calls.length, 0);
});

// Summary

summaryExit();
