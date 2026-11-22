import type { DeviceImageSpec, DeviceModel } from '../devices/driver.js';

// model.image is calibrated for CORA images (pre-rotated by desktop software).
// Splash source images are upright (natural canvas orientation).
// model.splash.transformOverride corrects for the orientation difference measured on hardware.
// Also the upright → device-native transform that places the stale badge (badge-corner.ts).
export function splashSpec(model: DeviceModel): DeviceImageSpec {
  const t = model.splash?.transformOverride;
  if (!t) return model.image;
  return {
    ...model.image,
    ...(t.rotate !== undefined && { rotate: t.rotate }),
    ...(t.flipH !== undefined && { flipH: t.flipH }),
    ...(t.flipV !== undefined && { flipV: t.flipV }),
  };
}
