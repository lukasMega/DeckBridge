import assert from 'tjs:assert';
import { EventEmitter } from '../src/platform/events-shim.js';
import { splashSpec, sendSplashImages } from '../src/splash-sender.js';
import { mk2IndexToDeviceImgId } from '../src/key-map.js';
import type { DeviceDriver, DeviceImageSpec } from '../src/devices/driver.js';
import { MIRABOX_293_MODEL } from '../src/devices/mirabox/mirabox-293.js';
import { DEFAULT_MODEL } from '../src/devices/registry.js';
import { test, summaryExit } from './helpers/harness.js';

class FakeDriver extends EventEmitter {
  readonly model;
  splashCalls: { keyIndex: number; spec: DeviceImageSpec }[] = [];
  constructor(model: DeviceDriver['model']) {
    super();
    this.model = model;
  }
  sendSplashImage(keyIndex: number, _bytes: Uint8Array, spec: DeviceImageSpec): void {
    this.splashCalls.push({ keyIndex, spec });
  }
}

test('sendSplashImages: mirabox-293 splash keys remap through coraToWireImage (mk2IndexToDeviceImgId)', () => {
  const driver = new FakeDriver(MIRABOX_293_MODEL);
  sendSplashImages(driver as unknown as DeviceDriver);
  // MIRABOX_293_MODEL.keyCount >= 15, so splash-sender uses SPLASH_KEYS_15.
  const expectedMk2Keys = [0, 1, 2, 5, 6, 7];
  const expected = expectedMk2Keys.map((mk2) => mk2IndexToDeviceImgId(mk2, MIRABOX_293_MODEL));
  assert.deepEqual(
    driver.splashCalls.map((c) => c.keyIndex),
    expected,
  );
});

test('sendSplashImages: no-op (and no throw) when driver has no sendSplashImage', () => {
  const driver = new FakeDriver(DEFAULT_MODEL);
  driver.sendSplashImage = undefined as unknown as FakeDriver['sendSplashImage'];
  sendSplashImages(driver as unknown as DeviceDriver);
  assert.equal(driver.splashCalls.length, 0);
});

test('splashSpec: no transformOverride returns model.image unchanged', () => {
  const model: DeviceDriver['model'] = { ...MIRABOX_293_MODEL, splash: undefined };
  assert.equal(splashSpec(model), model.image);
});

test('splashSpec: transformOverride fields overlay model.image, others untouched', () => {
  const model: DeviceDriver['model'] = {
    ...MIRABOX_293_MODEL,
    splash: { ...MIRABOX_293_MODEL.splash, transformOverride: { rotate: 180, flipH: true } },
  };
  const spec = splashSpec(model);
  assert.equal(spec.rotate, 180);
  assert.equal(spec.flipH, true);
  assert.equal(spec.width, model.image.width);
  assert.equal(spec.height, model.image.height);
});

summaryExit();
