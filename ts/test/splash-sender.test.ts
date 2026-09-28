import assert from 'tjs:assert';
import { splashSpec, sendSplashImages } from '../src/shared/splash-sender.js';
import { mk2IndexToDeviceImgId } from '../src/shared/key-map.js';
import type { DeviceImageSpec, DeviceModel } from '../src/devices/driver.js';
import { MockDriver } from '../src/devices/mock.js';
import { StubDockDriver } from './helpers/stub-dock-driver.js';
import { MIRABOX_293_MODEL } from '../src/devices/mirabox/mirabox-293.js';
import { DEFAULT_MODEL } from '../src/devices/registry.js';
import { test, summaryExit } from './helpers/harness.js';

class FakeDriver extends StubDockDriver {
  splashCalls: { keyIndex: number; spec: DeviceImageSpec }[] = [];
  override sendSplashImage(keyIndex: number, _bytes: Uint8Array, spec: DeviceImageSpec): void {
    this.splashCalls.push({ keyIndex, spec });
  }
}

test('sendSplashImages: mirabox-293 splash keys remap through coraToWireImage (mk2IndexToDeviceImgId)', () => {
  const driver = new FakeDriver(MIRABOX_293_MODEL);
  sendSplashImages(driver);
  // MIRABOX_293_MODEL.keyCount >= 15, so splash-sender uses SPLASH_KEYS_15.
  const expectedMk2Keys = [0, 1, 2, 5, 6, 7];
  const expected = expectedMk2Keys.map((mk2) => mk2IndexToDeviceImgId(mk2, MIRABOX_293_MODEL));
  assert.deepEqual(
    driver.splashCalls.map((c) => c.keyIndex),
    expected,
  );
});

test('sendSplashImages: harmless on the mock (its sendSplashImage is a no-op)', () => {
  sendSplashImages(new MockDriver(DEFAULT_MODEL));
  assert.ok(true, 'no throw');
});

test('splashSpec: no transformOverride returns model.image unchanged', () => {
  const model: DeviceModel = { ...MIRABOX_293_MODEL, splash: undefined };
  assert.equal(splashSpec(model), model.image);
});

test('splashSpec: transformOverride fields overlay model.image, others untouched', () => {
  const model: DeviceModel = {
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
