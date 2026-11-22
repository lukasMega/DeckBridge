import { SPLASH_STATES } from '../assets/splash-states.js';
import { mk2IndexToDeviceImgId } from './key-map.js';
import { splashSpec } from './splash-spec.js';
import type { DockDriver } from '../devices/driver.js';

// Single device-independent splash image, decoded once at module load.
const SPLASH_CONNECTED = Buffer.from(SPLASH_STATES.connected, 'base64');

// Keys to fill on 15-key devices (MK2 indices): top-left 2×3 block.
const SPLASH_KEYS_15 = [0, 1, 2, 5, 6, 7] as const;
// Keys to fill on smaller devices (fill all, up to 6).
const SPLASH_KEY_COUNT_SMALL = 6;

export { splashSpec };

/** The worker transforms each splash image (sendSplashImage), keeping the synchronous
 *  FFI transform off the main thread (P1 / Finding 1). */
export function sendSplashImages(driver: DockDriver): void {
  const model = driver.model;
  const spec = splashSpec(model);

  const splashKeys: readonly number[] =
    model.splash?.keys ??
    (model.keyCount >= 15
      ? SPLASH_KEYS_15
      : Array.from({ length: Math.min(model.keyCount, SPLASH_KEY_COUNT_SMALL) }, (_, i) => i));

  for (const mk2 of splashKeys) {
    // Match the live image path (image-render.ts): remap mk2 → device wire id
    // when the model defines an image keyMap; Elgato (no keyMap) passes through.
    const deviceKeyIndex = mk2IndexToDeviceImgId(mk2, model);
    if (deviceKeyIndex < 0) continue; // a grid cell with no display (Ulanzi D200)
    // Every key gets the same device-independent "connected" image. Source
    // bytes are a constant — no copy needed here; WorkerHidDriver.sendSplashImage
    // copies before postMessage.
    driver.sendSplashImage(deviceKeyIndex, SPLASH_CONNECTED, spec);
  }
}
