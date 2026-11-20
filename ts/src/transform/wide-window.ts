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
    const bmps: Array<{ x: number; bmp: Uint8Array }> = [];
    this.cells.forEach((key, i) => {
      const frame = this.frames.get(key);
      if (frame) bmps.push({ x: xs[i]!, bmp: transformImageForDevice(frame.bytes, cell) });
    });
    const fast = composeFromBmpRows(bmps, cell, width, height, y);
    if (fast) return fast;
    const canvas = new Uint8Array(width * height * 3);
    for (const { x, bmp } of bmps) blitImage(canvas, width, height, bmp, x, y);
    return canvasSliceToBmp(canvas, width, height, 0, width);
  }
}

/** True when `bmp` is a plain 24-bit BMP of exactly `cell` size that lands inside the window. */
function cellFits(
  bmp: Uint8Array,
  cell: DeviceImageSpec,
  cellRow: number,
  x: number,
  y: number,
  width: number,
  height: number,
): boolean {
  if (x < 0 || y < 0 || x + cell.width > width || y + cell.height > height) return false;
  if (bmp.length < 54 || bmp[0] !== 0x42 || bmp[1] !== 0x4d) return false;
  const v = new DataView(bmp.buffer, bmp.byteOffset, bmp.byteLength);
  return (
    v.getInt32(18, true) === cell.width &&
    v.getInt32(22, true) === cell.height &&
    v.getUint16(28, true) === 24 &&
    v.getUint32(30, true) === 0 &&
    v.getUint32(10, true) + cellRow * cell.height <= bmp.length
  );
}

/** Window BMP assembled by copying each cell BMP's rows (both bottom-up BGR), skipping the
 *  decode + per-pixel repack of the canvas path (~5x faster, same bytes). Null when a cell
 *  isn't a plain 24-bit BMP of the expected size or doesn't fit, so the caller blits instead. */
function composeFromBmpRows(
  cells: ReadonlyArray<{ x: number; bmp: Uint8Array }>,
  cell: DeviceImageSpec,
  width: number,
  height: number,
  y: number,
): Uint8Array | null {
  const rowBytes = (width * 3 + 3) & ~3;
  const cellRow = (cell.width * 3 + 3) & ~3;
  const base = height - y - cell.height; // window row (from the bottom) of the cell's bottom row
  for (const { x, bmp } of cells) {
    if (!cellFits(bmp, cell, cellRow, x, y, width, height)) return null;
  }
  const out = new Uint8Array(54 + rowBytes * height);
  const hv = new DataView(out.buffer);
  out[0] = 0x42;
  out[1] = 0x4d;
  hv.setUint32(2, out.length, true);
  hv.setUint32(10, 54, true);
  hv.setUint32(14, 40, true);
  hv.setInt32(18, width, true);
  hv.setInt32(22, height, true);
  hv.setUint16(26, 1, true);
  hv.setUint16(28, 24, true);
  for (const { x, bmp } of cells) {
    const off = new DataView(bmp.buffer, bmp.byteOffset, bmp.byteLength).getUint32(10, true);
    for (let r = 0; r < cell.height; r++) {
      const s = off + r * cellRow;
      out.set(bmp.subarray(s, s + cell.width * 3), 54 + (base + r) * rowBytes + x * 3);
    }
  }
  return out;
}
