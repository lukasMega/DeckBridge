export function rotateFlip(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  rotate: 0 | 90 | 180 | 270,
  flipH: boolean,
  flipV: boolean,
): { rgba: Uint8ClampedArray; w: number; h: number } {
  const width = rotate === 90 || rotate === 270 ? h : w;
  const height = rotate === 90 || rotate === 270 ? w : h;
  const result = new Uint8ClampedArray(rgba.length);
  for (let pixel = 0; pixel < w * h; pixel++) {
    const x = pixel % w;
    const y = Math.floor(pixel / w);
    let dx = x,
      dy = y;
    switch (rotate) {
      case 90:
        dx = h - 1 - y;
        dy = x;
        break;
      case 180:
        dx = w - 1 - x;
        dy = h - 1 - y;
        break;
      case 270:
        dx = y;
        dy = w - 1 - x;
        break;
    }
    if (flipH) dx = width - 1 - dx;
    if (flipV) dy = height - 1 - dy;
    const src = pixel * 4;
    result.set(rgba.subarray(src, src + 4), (dy * width + dx) * 4);
  }
  return { rgba: result, w: width, h: height };
}

export function swapRB(rgba: Uint8ClampedArray): void {
  for (let i = 0; i < rgba.length; i += 4) {
    const red = rgba[i]!;
    rgba[i] = rgba[i + 2]!;
    rgba[i + 2] = red;
  }
}

export function encodeBmp(rgba: Uint8ClampedArray, w: number, h: number, ppm = 0): Uint8Array {
  const stride = (w * 3 + 3) & ~3;
  const bytes = new Uint8Array(54 + stride * h);
  const view = new DataView(bytes.buffer);
  bytes.set([0x42, 0x4d]);
  view.setUint32(2, bytes.length, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, w, true);
  view.setInt32(22, h, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, stride * h, true);
  view.setInt32(38, ppm, true);
  view.setInt32(42, ppm, true);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = (y * w + x) * 4;
      const dst = 54 + (h - 1 - y) * stride + x * 3;
      bytes[dst] = rgba[src + 2]!;
      bytes[dst + 1] = rgba[src + 1]!;
      bytes[dst + 2] = rgba[src]!;
    }
  }
  return bytes;
}

export function stripApp2(jpeg: Uint8Array): Uint8Array {
  const parts = [jpeg.subarray(0, 2)];
  let offset = 2;
  while (offset + 3 < jpeg.length) {
    const marker = jpeg[offset + 1]!;
    if (marker === 0xda || marker === 0xd9) break;
    const end = offset + 2 + ((jpeg[offset + 2]! << 8) | jpeg[offset + 3]!);
    if (jpeg[offset] !== 0xff || end <= offset + 3 || end > jpeg.length) break;
    if (marker !== 0xe2) parts.push(jpeg.subarray(offset, end));
    offset = end;
  }
  parts.push(jpeg.subarray(offset));
  const result = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let pos = 0;
  for (const part of parts) {
    result.set(part, pos);
    pos += part.length;
  }
  return result;
}
