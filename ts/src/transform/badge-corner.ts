import type { DeviceImageSpec } from '../devices/driver.js';

/** The `badge` corner of image_proc_transform (1 = top-left, 2 = top-right, 3 = bottom-right,
 *  4 = bottom-left of the sent image) that shows top-right on the panel. Pass the model's
 *  `splashSpec()`: its rotate/flip turn an UPRIGHT image into the sent one (a CORA frame is
 *  already pre-rotated by the app, so `model.image` would put the badge in the wrong corner).
 *  This follows the upright top-right through them in the transform's order: rotate
 *  (clockwise), flipH, flipV. */
export function badgeCorner(spec: Pick<DeviceImageSpec, 'rotate' | 'flipH' | 'flipV'>): number {
  let corner = 2;
  corner = ((corner - 1 + spec.rotate / 90) % 4) + 1;
  if (spec.flipH) corner = [0, 2, 1, 4, 3][corner]!;
  if (spec.flipV) corner = [0, 4, 3, 2, 1][corner]!;
  return corner;
}
