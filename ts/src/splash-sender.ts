import { SPLASH_STATES } from './assets/splash-states.js';
import { mk2IndexToDeviceImgId } from './translator.js';
import type { DeviceDriver, DeviceImageSpec } from './devices/driver.js';
import { log } from './logger.js';

// Single device-independent splash image, decoded once at module load.
const SPLASH_CONNECTED = Buffer.from(SPLASH_STATES.connected, 'base64');

// Keys to fill on 15-key devices (MK2 indices): top-left 2×3 block.
const SPLASH_KEYS_15 = [0, 1, 2, 5, 6, 7] as const;
// Keys to fill on smaller devices (fill all, up to 6).
const SPLASH_KEY_COUNT_SMALL = 6;

// model.image is calibrated for CORA images (pre-rotated by desktop software).
// Splash source images are upright (natural canvas orientation).
// model.splash.transformOverride corrects for the orientation difference measured on hardware.
function splashSpec(model: DeviceDriver['model']): DeviceImageSpec {
  const t = model.splash?.transformOverride;
  if (!t) return model.image;
  return {
    ...model.image,
    ...(t.rotate !== undefined && { rotate: t.rotate }),
    ...(t.flipH !== undefined && { flipH: t.flipH }),
    ...(t.flipV !== undefined && { flipV: t.flipV }),
  };
}

export function sendSplashImages(driver: DeviceDriver): void {
  // Requires sendSplashImage (WorkerHidDriver) to offload the 50–200 ms
  // synchronous FFI transform off the main thread (P1 / Finding 1).
  // MockDriver has no USB device to paint, so the absence is expected.
  if (!driver.sendSplashImage) {
    log('debug', 'splash', 'driver has no sendSplashImage — skipping splash');
    return;
  }

  const model = driver.model;
  const spec = splashSpec(model);

  const splashKeys: readonly number[] =
    model.splash?.keys ??
    (model.keyCount >= 15
      ? SPLASH_KEYS_15
      : Array.from({ length: Math.min(model.keyCount, SPLASH_KEY_COUNT_SMALL) }, (_, i) => i));

  for (const mk2 of splashKeys) {
    // Match the live image path (image-pipeline.ts): remap mk2 → device wire id
    // when the model defines an image keyMap; Elgato (no keyMap) passes through.
    const deviceKeyIndex =
      model.keyMap.coraToWireImage || model.keyMap.imageOffset != null
        ? mk2IndexToDeviceImgId(mk2, model)
        : mk2;
    // Every key gets the same device-independent "connected" image. Source
    // bytes are a constant — no copy needed here; WorkerHidDriver.sendSplashImage
    // copies before postMessage.
    driver.sendSplashImage(deviceKeyIndex, SPLASH_CONNECTED, spec);
  }
}
