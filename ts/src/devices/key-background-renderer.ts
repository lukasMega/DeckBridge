import type { DockDriver } from './driver.js';
import { mk2IndexToDeviceImgId } from '../shared/key-map.js';
import { blitImage, canvasSliceToBmp, transformImageForDevice } from '../transform/translator.js';

type BackgroundPixels = { width: number; height: number; rgb: Uint8Array };

export function createKeyBackgroundRenderer(driver: DockDriver) {
  const spec = driver.model.image;
  const rowBytes = (spec.width * 3 + 3) & ~3;
  const surfaces = Array.from({ length: 10 }, (_unused, index) => {
    const wire = index < 5 ? index + 11 : index + 1;
    const key = Array.from({ length: 8 }, (_, slot) => slot).find(
      (slot) => mk2IndexToDeviceImgId(slot, driver.model) === wire,
    );
    return {
      wire,
      key,
      x: (index % 5) * 22.5,
      y: Math.floor(index / 5) * 22,
      pixels: new Uint8Array(spec.width * spec.height * 3),
      icon: new Uint8Array(spec.width * spec.height * 3),
      last: undefined as Uint8Array | undefined,
      black: -1,
      paint: [] as number[],
      sent: '',
    };
  });
  const cache = new Map<string, Map<number, Uint8Array>>();
  type Tile = (typeof surfaces)[number];

  function cachedFrame(frameKey: string): Map<number, Uint8Array> {
    let cached = cache.get(frameKey);
    if (!cached) {
      if (cache.size >= 120) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cached = new Map();
      cache.set(frameKey, cached);
    }
    return cached;
  }

  function updateIcon(tile: Tile, image: Uint8Array | undefined, black: number): boolean {
    const changed = image !== tile.last || black !== tile.black;
    if (image !== tile.last) {
      tile.icon.fill(0);
      if (image) {
        const bmp = transformImageForDevice(image, {
          ...spec,
          format: 'bmp',
          rotate: 0,
          flipH: false,
          flipV: false,
          maxBytes: 0,
          sharpen: 0,
        });
        blitImage(tile.icon, spec.width, spec.height, bmp, 0, 0);
      }
      tile.last = image;
    }
    if (changed) {
      tile.black = black;
      tile.paint.length = 0;
      if (image) {
        for (let y = 0, i = 0; y < spec.height; y++) {
          const row = 54 + (spec.height - 1 - y) * rowBytes;
          for (let x = 0; x < spec.width; x++, i += 3) {
            const r = tile.icon[i]!,
              g = tile.icon[i + 1]!,
              b = tile.icon[i + 2]!;
            if (Math.max(r, g, b) > black) {
              tile.paint.push(row + x * 3, b, g, r);
            }
          }
        }
      }
    }
    return changed;
  }

  function makeTile(tile: Tile, candidate: BackgroundPixels): Uint8Array {
    const columns = Array.from(
      { length: spec.width },
      (_, x) => Math.floor(((tile.x + ((x + 0.5) * 15) / spec.width) * candidate.width) / 105) * 3,
    );
    let i = 0;
    for (let y = 0; y < spec.height; y++) {
      const row =
        Math.floor(((tile.y + ((y + 0.5) * 15) / spec.height) * candidate.height) / 59) *
        candidate.width *
        3;
      for (const col of columns) {
        const from = row + col;
        tile.pixels[i++] = candidate.rgb[from]!;
        tile.pixels[i++] = candidate.rgb[from + 1]!;
        tile.pixels[i++] = candidate.rgb[from + 2]!;
      }
    }
    return canvasSliceToBmp(tile.pixels, spec.width, spec.height, 0, spec.width);
  }

  return {
    reset() {
      for (const tile of surfaces) tile.sent = '';
    },
    render(
      candidate: BackgroundPixels & { id: string; black: number; quality: number },
      freshImage: (key: number) => Uint8Array | undefined,
    ) {
      const frameKey = `${candidate.width}:${candidate.height}:${candidate.id}`;
      const cached = cachedFrame(frameKey);
      const signature = `${frameKey}:${candidate.quality}`;
      for (const tile of surfaces) {
        const image = tile.key === undefined ? undefined : freshImage(tile.key);
        const changed = updateIcon(tile, image, candidate.black);
        if (!changed && tile.sent === signature) continue;
        let bmp = cached.get(tile.wire);
        if (!bmp) {
          bmp = makeTile(tile, candidate);
          cached.set(tile.wire, bmp);
        }
        driver.sendSplashImage(tile.wire, paintIcon(bmp, tile.paint), {
          ...spec,
          quality: candidate.quality / 100,
        });
        tile.sent = signature;
      }
    },
  };
}

function paintIcon(bmp: Uint8Array, paint: number[]): Uint8Array {
  if (paint.length) {
    bmp = bmp.slice();
    for (let i = 0; i < paint.length; i += 4) {
      const offset = paint[i]!;
      bmp[offset] = paint[i + 1]!;
      bmp[offset + 1] = paint[i + 2]!;
      bmp[offset + 2] = paint[i + 3]!;
    }
  }
  return bmp;
}
