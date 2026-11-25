import type { DockDriver } from '../devices/driver.js';
import type { KeyBackgroundFrame } from '../extension/api.js';
import { mk2IndexToDeviceImgId } from '../shared/key-map.js';
import { log } from '../shared/logger.js';
import { blitImage, canvasSliceToBmp, transformImageForDevice } from '../transform/translator.js';
import type { LastFrames } from './dock-frames.js';

function valid(frame: KeyBackgroundFrame | null): frame is KeyBackgroundFrame {
  return !!frame && typeof frame.id === 'string' && frame.id.length > 0 && frame.id.length <= 96 &&
    Number.isInteger(frame.width) && frame.width > 0 && frame.width <= 840 &&
    Number.isInteger(frame.height) && frame.height > 0 && frame.height <= 472 &&
    frame.rgb instanceof Uint8Array && frame.rgb.length === frame.width * frame.height * 3 &&
    Number.isInteger(frame.fps) && frame.fps >= 1 && frame.fps <= 31 &&
    Number.isInteger(frame.quality) && frame.quality >= 1 && frame.quality <= 100 &&
    Number.isInteger(frame.black) && frame.black >= 0 && frame.black <= 255;
}

/** One serial pull per dock. Normal CORA output resumes as soon as the source yields. */
export async function playKeyBackground(
  driver: DockDriver,
  frames: LastFrames,
  pull: () => Promise<KeyBackgroundFrame | null>,
  attached: () => boolean,
  canPaint: () => boolean,
  ownership: (owns: boolean) => void,
): Promise<void> {
  const spec = driver.model.image;
  const rowBytes = (spec.width * 3 + 3) & ~3;
  const surfaces = Array.from({ length: 10 }, (_, index) => {
    const wire = index < 5 ? index + 11 : index + 1;
    const key = Array.from({ length: 8 }, (_, key) => key)
      .find((key) => mk2IndexToDeviceImgId(key, driver.model) === wire);
    return {
      wire, key, x: (index % 5) * 22.5, y: Math.floor(index / 5) * 22,
      pixels: new Uint8Array(spec.width * spec.height * 3),
      icon: new Uint8Array(spec.width * spec.height * 3),
      last: undefined as Uint8Array | undefined,
      black: -1,
      paint: [] as number[],
      sent: '',
    };
  });
  let owned = false;
  const cache = new Map<string, Map<number, Uint8Array>>();
  const release = () => {
    if (!owned) return;
    owned = false;
    ownership(false);
    for (const tile of surfaces) tile.sent = '';
    log('info', 'extensions', 'AKP05E key background released');
    if (attached() && canPaint()) frames.repaint(driver);
  };
  try {
    while (attached()) {
      const start = Date.now();
      const candidate = canPaint() ? await pull().catch(() => null) : null;
      if (!attached()) break;
      let delay = 250;
      if (canPaint() && valid(candidate)) {
        delay = 1000 / candidate.fps;
        try {
          const frameKey = `${candidate.width}:${candidate.height}:${candidate.id}`;
          let cached = cache.get(frameKey);
          if (!cached) {
            if (cache.size >= 120) {
              const oldest = cache.keys().next().value;
              if (oldest !== undefined) cache.delete(oldest);
            }
            cached = new Map();
            cache.set(frameKey, cached);
          }
          for (const tile of surfaces) {
            const image = tile.key === undefined ? undefined : frames.freshImage(tile.key);
            const changed = image !== tile.last || candidate.black !== tile.black;
            if (image !== tile.last) {
              tile.icon.fill(0);
              if (image) {
                const bmp = transformImageForDevice(image, {
                  ...spec, format: 'bmp', rotate: 0, flipH: false, flipV: false,
                  maxBytes: 0, sharpen: 0,
                });
                blitImage(tile.icon, spec.width, spec.height, bmp, 0, 0);
              }
              tile.last = image;
            }
            if (changed) {
              tile.black = candidate.black;
              tile.paint.length = 0;
              if (image) {
                for (let y = 0, i = 0; y < spec.height; y++) {
                  const row = 54 + (spec.height - 1 - y) * rowBytes;
                  for (let x = 0; x < spec.width; x++, i += 3) {
                    const r = tile.icon[i]!, g = tile.icon[i + 1]!, b = tile.icon[i + 2]!;
                    if (Math.max(r, g, b) > candidate.black) {
                      tile.paint.push(row + x * 3, b, g, r);
                    }
                  }
                }
              }
            }
            const signature = `${frameKey}:${candidate.quality}`;
            if (!changed && tile.sent === signature) continue;
            let bmp = cached.get(tile.wire);
            if (!bmp) {
              const columns = Array.from({ length: spec.width }, (_, x) =>
                Math.floor((tile.x + (x + 0.5) * 15 / spec.width) * candidate.width / 105) * 3);
              let i = 0;
              for (let y = 0; y < spec.height; y++) {
                const row = Math.floor((tile.y + (y + 0.5) * 15 / spec.height) *
                  candidate.height / 59) * candidate.width * 3;
                for (const col of columns) {
                  const from = row + col;
                  tile.pixels[i++] = candidate.rgb[from]!;
                  tile.pixels[i++] = candidate.rgb[from + 1]!;
                  tile.pixels[i++] = candidate.rgb[from + 2]!;
                }
              }
              bmp = canvasSliceToBmp(tile.pixels, spec.width, spec.height, 0, spec.width);
              cached.set(tile.wire, bmp);
            }
            if (tile.paint.length) {
              bmp = bmp.slice();
              for (let i = 0; i < tile.paint.length; i += 4) {
                const offset = tile.paint[i]!;
                bmp[offset] = tile.paint[i + 1]!;
                bmp[offset + 1] = tile.paint[i + 2]!;
                bmp[offset + 2] = tile.paint[i + 3]!;
              }
            }
            driver.sendSplashImage(tile.wire, bmp, { ...spec, quality: candidate.quality / 100 });
            tile.sent = signature;
          }
          if (!owned) {
            owned = true;
            ownership(true);
            log('info', 'extensions', 'AKP05E key background active (10 keys)');
          }
        } catch (error) {
          log('warn', 'extensions', `AKP05E key background: ${String(error)}`);
          if (owned) release();
          else frames.repaint(driver);
          delay = 250;
        }
      } else {
        release();
      }
      const deadline = start + delay;
      do {
        await new Promise<void>((resolve) => setTimeout(resolve, Math.max(1, Math.ceil(deadline - Date.now()))));
      } while (attached() && Date.now() < deadline);
    }
  } finally {
    release();
  }
}
