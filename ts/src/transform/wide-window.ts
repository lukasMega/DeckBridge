/** Worker-side Elgato images of a standalone wide display (the D200 info window): the
 *  app's last frame of each source cell, scaled to a key and composed side by side (one
 *  cell: centred) on black, then sent as the display's image. See docs/plugin-widgets.md#d200-info-window. */
import { warn } from '../shared/logger.js';
import { blitImage, canvasSliceToBmp, transformImageForDevice } from './translator.js';
import type { DeviceImageSpec, DeviceModel } from '../devices/driver.js';

interface RenderTarget {
  sendImage(keyIndex: number, bytes: Uint8Array): void;
}

type Frame = { bytes: Uint8Array };

export class WideWindowCanvas {
  private wireId = -1;
  private cells: readonly number[] = [];
  private show = false;
  private readonly frames = new Map<number, Frame>();

  /** A new device (or none): no window, nothing kept. */
  reset(): void {
    this.wireId = -1;
    this.cells = [];
    this.show = false;
    this.frames.clear();
  }

  /** Main replays the source frames after this, so nothing is drawn here. */
  configure(wireId: number, cells: readonly number[], show: boolean): void {
    this.wireId = wireId;
    this.cells = cells;
    this.show = show;
    for (const cell of this.frames.keys()) if (!cells.includes(cell)) this.frames.delete(cell);
  }

  /** True = `keyIndex` is a source cell: the frame is kept (and drawn while shown). */
  apply(driver: RenderTarget, model: DeviceModel, keyIndex: number, bytes: Uint8Array): boolean {
    if (!this.cells.includes(keyIndex)) return false;
    this.frames.set(keyIndex, { bytes });
    if (!this.show) return true;
    const display = model.widgetDisplays?.find((d) => d.wireId === this.wireId);
    if (!display) return true;
    try {
      driver.sendImage(
        this.wireId,
        transformImageForDevice(this.compose(model, display.image), display.image),
      );
    } catch (err) {
      warn('image', `info window render failed: ${(err as Error).message}`);
    }
    return true;
  }

  /** The window as an upright BMP: each kept cell at key size, the app's orientation undone
   *  by the key spec's own rotate/flip. */
  private compose(model: DeviceModel, window: DeviceImageSpec): Uint8Array {
    const { width, height } = window;
    const canvas = new Uint8Array(width * height * 3);
    const cell: DeviceImageSpec = {
      ...model.image,
      format: 'bmp',
      width: model.keyWidth,
      height: model.keyHeight,
      maxBytes: 0,
    };
    const y = Math.floor((height - cell.height) / 2);
    const xs =
      this.cells.length === 1 ? [Math.floor((width - cell.width) / 2)] : [0, width - cell.width];
    this.cells.forEach((key, i) => {
      const frame = this.frames.get(key);
      if (frame)
        blitImage(canvas, width, height, transformImageForDevice(frame.bytes, cell), xs[i]!, y);
    });
    return canvasSliceToBmp(canvas, width, height, 0, width);
  }
}
