import type { DeviceImageSpec } from '../devices/driver.js';
import { encodeBmp, rotateFlip, stripApp2, swapRB } from './pixels.js';

export async function encodeKeyImage(
  icon: OffscreenCanvas,
  spec: DeviceImageSpec,
): Promise<Uint8Array> {
  // Native-sized demo canvases need no crop, resize, blur or sharpening.
  const source = icon.getContext('2d')!.getImageData(0, 0, icon.width, icon.height);
  const pixels = rotateFlip(
    source.data,
    icon.width,
    icon.height,
    spec.rotate,
    spec.flipH,
    spec.flipV,
  );
  if (spec.colorMode === 'bgr') swapRB(pixels.rgba);
  if (spec.format === 'bmp') return encodeBmp(pixels.rgba, pixels.w, pixels.h, spec.bmpPpm);
  const canvas = new OffscreenCanvas(spec.width, spec.height);
  canvas
    .getContext('2d')!
    .putImageData(new ImageData(new Uint8ClampedArray(pixels.rgba), pixels.w, pixels.h), 0, 0);
  let quality = Math.min(spec.quality, 0.95);
  async function jpeg(q: number): Promise<Uint8Array> {
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: q });
    return stripApp2(new Uint8Array(await blob.arrayBuffer()));
  }
  let bytes = await jpeg(quality);
  while (spec.maxBytes > 0 && bytes.length > spec.maxBytes && quality > 0.3) {
    quality = Math.max(0.3, quality - 0.05);
    bytes = await jpeg(quality);
  }
  return bytes;
}
