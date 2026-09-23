import assert from 'tjs:assert';
import { renderImage, TouchStripCanvas } from '../src/image-render.js';
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
await test('sidecar model produces a valid JPEG ≤ maxBytes', async () => {
  const fake = makeFakeDriver();
  await renderImage(fake, MIRABOX_293_MODEL, 0, SOLID_RED_16X16_JPEG, 'jpeg');

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
await test('second identical image is a cache hit (same bytes)', async () => {
  const distinct = Buffer.from(SOLID_RED_16X16_JPEG);
  distinct[distinct.length - 5] = (distinct[distinct.length - 5]! ^ 0x55) & 0xff;
  const fake = makeFakeDriver();

  await renderImage(fake, MIRABOX_293_MODEL, 1, distinct, 'jpeg');
  assert.equal(fake.calls.length, 1, 'first render should call sendImage once');
  const firstBytes = fake.calls[0]!.bytes;

  await renderImage(fake, MIRABOX_293_MODEL, 1, distinct, 'jpeg');
  assert.equal(fake.calls.length, 2, 'second render should call sendImage again');
  const secondBytes = fake.calls[1]!.bytes;

  assert.deepEqual(
    Array.from(secondBytes),
    Array.from(firstBytes),
    'cache hit must yield byte-identical output to the first transform',
  );
});

// 3. key remap: sendImage keyIndex equals coraToWireImage[0] (NOT 0).
await test('key remap: sendImage receives mapped device key index', async () => {
  const fake = makeFakeDriver();
  await renderImage(fake, MIRABOX_293_MODEL, 0, SOLID_RED_16X16_JPEG, 'jpeg');

  assert.equal(fake.calls.length, 1, 'sendImage should be called once');
  assert.equal(
    fake.calls[0]!.keyIndex,
    coraToWireImage[0],
    `sendImage keyIndex should be coraToWireImage[0] (${coraToWireImage[0]}), not 0`,
  );
});

// 4. out-of-range key (coraToWireImage[99] === undefined → -1) is skipped.
await test('out-of-range key is skipped (no sendImage)', async () => {
  const fake = makeFakeDriver();
  await renderImage(fake, MIRABOX_293_MODEL, 99, SOLID_RED_16X16_JPEG, 'jpeg');

  assert.equal(
    fake.calls.length,
    0,
    'sendImage must not be called when the mapped device key index is < 0',
  );
});

// 5. passthrough model forwards original bytes unchanged (no transform).
await test('passthrough model forwards original bytes unchanged', async () => {
  const model = makePassthroughModel();
  const fake = makeFakeDriver();
  // Distinct bytes that begin like a JPEG but are not a real image — proves no
  // transform ran (a transform would reject/alter these).
  const someBytes = Buffer.from([0xff, 0xd8, 0x11, 0x22, 0x33, 0x44, 0x55, 0xff, 0xd9]);

  await renderImage(fake, model, 1, someBytes, 'jpeg');

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

await test('a partial window re-sends only the zones it touches, each whole', () => {
  const canvas = new TouchStripCanvas();
  const driver = makeFakeDriver();
  const patch = (x: number): void =>
    canvas.apply(driver, AJAZZ_AKP05E_MODEL, SOLID_RED_16X16_JPEG, { x, y: 40, w: 16, h: 16 });
  patch(416);
  patch(192); // straddles zones 1 and 2
  const [z1, z2] = AJAZZ_AKP05E_MODEL.widgetDisplays!;
  assert.deepEqual(
    driver.calls.map((c) => c.keyIndex),
    [AJAZZ_AKP05E_MODEL.widgetDisplays![2]!.wireId, z1!.wireId, z2!.wireId],
  );
  assert.ok(driver.calls.every((c) => c.bytes.length > 0));
});

await test('a full window (no region) re-sends every zone', () => {
  const driver = makeFakeDriver();
  new TouchStripCanvas().apply(driver, AJAZZ_AKP05E_MODEL, SOLID_RED_16X16_JPEG);
  assert.equal(driver.calls.length, AJAZZ_AKP05E_MODEL.widgetDisplays!.length);
});

await test('an undecodable window sends nothing', () => {
  const driver = makeFakeDriver();
  new TouchStripCanvas().apply(driver, AJAZZ_AKP05E_MODEL, new Uint8Array([1, 2, 3]));
  assert.equal(driver.calls.length, 0);
});

// Summary

summaryExit();
