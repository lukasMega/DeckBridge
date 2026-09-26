import assert from 'tjs:assert';
import { jpegSize } from '../src/devices/jpeg-size.js';
import { AJAZZ_AKP05E_MODEL } from '../src/devices/ajazz/akp05e.js';
import { transformImageForDevice } from '../src/translator.js';
import { test, summaryExit } from './helpers/harness.js';
import { SOLID_RED_16X16_JPEG } from './helpers/fixtures.js';

const SLOT = AJAZZ_AKP05E_MODEL.widgetDisplays![0]!.image;
const STRIP = AJAZZ_AKP05E_MODEL.touchStripDisplay!.image;

test('reads the frame size of transform output (slot 176×112, full strip 800×112)', () => {
  for (const spec of [SLOT, STRIP, AJAZZ_AKP05E_MODEL.image]) {
    const jpeg = transformImageForDevice(SOLID_RED_16X16_JPEG, { ...spec, sharpen: 0 });
    assert.deepEqual(jpegSize(jpeg), { width: spec.width, height: spec.height });
  }
  assert.deepEqual(jpegSize(SOLID_RED_16X16_JPEG), { width: 16, height: 16 });
});

test('returns null for empty, truncated, or non-JPEG bytes', () => {
  const jpeg = transformImageForDevice(SOLID_RED_16X16_JPEG, { ...SLOT, sharpen: 0 });
  const sof = jpeg.findIndex((b, i) => b === 0xff && jpeg[i + 1] === 0xc0);
  assert.ok(sof > 0, 'fixture has a SOF0');
  assert.equal(jpegSize(new Uint8Array(0)), null, 'empty');
  assert.equal(jpegSize(jpeg.subarray(0, sof + 6)), null, 'truncated inside SOF');
  assert.equal(jpegSize(jpeg.subarray(0, 20)), null, 'truncated before SOF');
  assert.equal(jpegSize(Buffer.from('not a jpeg at all')), null, 'no SOI');
  assert.equal(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), null, 'EOI before SOF');
  assert.equal(
    jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 0, 0, 0, 0, 0, 0])),
    null,
    'SOS before SOF',
  );
});

summaryExit();
