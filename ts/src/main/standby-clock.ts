// Standby clock: while the Elgato app is away, blank the grid and show a small
// clock + date pair that hops one slot per minute (burn-in care for the clock itself).
// Text only; app-owned strip zones go black. Controller: dock-standby.ts.
import type { DeviceImageSpec, DockDriver } from '../devices/driver.js';
import { advertisedGeometry } from '../devices/registry.js';
import { mk2IndexToDeviceImgId } from '../shared/key-map.js';
import { splashSpec } from '../shared/splash-sender.js';
import { layoutWidget, shiftLayout } from '../shared/widget-layout.js';
import type { WidgetLine } from '../shared/widget-layout.js';
import { composeLayout } from '../shared/widget-raster.js';
import type { ExtraKeyTextStyle } from '../shared/types.js';
import { renderWidgetLines } from './widget-lines.js';
import type { LastFrames, ImageFormat } from './dock-frames.js';
import { clockSlotAt, pixelShiftAt, standbyTiming } from './standby-policy.js';
import type { StandbyTiming } from './standby-policy.js';

export interface StandbyClockDeps {
  driver: () => DockDriver | null;
  frames: LastFrames;
  mirror?: (mk2: number, data: Buffer, format: ImageFormat) => void;
  /** Strip zones the app owns right now (not DeckBridge widgets): blacked during standby. */
  appOwnedZones: () => readonly number[];
  timing?: Pick<StandbyTiming, 'minuteMs' | 'pixelShiftPeriodMs'>;
}

// Dim grey on black: least retention-prone.
const STYLE: ExtraKeyTextStyle = { textSize: 'fit', color: '#8a8a90', background: '#000000' };

const BLACK = new Map<string, Uint8Array>();

export class StandbyClockPainter {
  private readonly timing: Pick<StandbyTiming, 'minuteMs' | 'pixelShiftPeriodMs'>;
  /** Grid keys (mk2) currently showing the clock/date pair. */
  private shown: number[] = [];
  /** Strip zones blacked out by start(). */
  private zones: readonly number[] = [];
  private started = false;

  constructor(private readonly deps: StandbyClockDeps) {
    this.timing = deps.timing ?? standbyTiming();
  }

  /** Clear the grid and the app-owned strip zones, then draw the pair for `nowMs`. */
  start(nowMs: number): void {
    const driver = this.deps.driver();
    if (!driver) return;
    this.started = true;
    this.shown = [];
    const { keyCount } = advertisedGeometry(driver.model);
    for (let mk2 = 0; mk2 < keyCount; mk2++) this.blank(driver, mk2);
    this.zones = this.deps.appOwnedZones();
    for (const wireId of this.zones) driver.clearKey(wireId);
    this.paintPair(driver, nowMs);
  }

  /** Move/refresh: blank the keys the pair left, draw it at the new slot. */
  paint(nowMs: number): void {
    const driver = this.deps.driver();
    if (!driver) return;
    if (!this.started) {
      this.start(nowMs);
      return;
    }
    this.paintPair(driver, nowMs);
  }

  /** Put the app's last frames back (and the strip zones); keys the pair used that
   *  have no frame are blanked. */
  stop(): void {
    const driver = this.deps.driver();
    const wasShown = this.shown;
    const zones = this.zones;
    this.started = false;
    this.shown = [];
    this.zones = [];
    if (!driver) return;
    this.deps.frames.repaint(driver, this.deps.mirror);
    for (const mk2 of wasShown) if (!this.deps.frames.has(mk2)) this.blank(driver, mk2);
    if (zones.length > 0) driver.restoreTouchSegments(zones);
  }

  private paintPair(driver: DockDriver, nowMs: number): void {
    const { columns, keyCount } = advertisedGeometry(driver.model);
    const slot = clockSlotAt(Math.floor(nowMs / this.timing.minuteMs), columns, keyCount);
    const next = columns >= 2 && slot + 1 < keyCount ? [slot, slot + 1] : [slot];
    for (const mk2 of this.shown) if (!next.includes(mk2)) this.blank(driver, mk2);
    const now = new Date(nowMs);
    const [clock, date] = [
      renderWidgetLines({ widget: 'clock' }, { now }),
      renderWidgetLines({ widget: 'date' }, { now }),
    ];
    this.paintKey(driver, next[0]!, clock, nowMs);
    if (next[1] !== undefined) this.paintKey(driver, next[1], date, nowMs);
    this.shown = next;
  }

  private paintKey(driver: DockDriver, mk2: number, lines: WidgetLine[] | null, nowMs: number) {
    const wire = mk2IndexToDeviceImgId(mk2, driver.model);
    if (wire < 0 || !lines) return;
    const spec = splashSpec(driver.model);
    const { width, height } = spec;
    // Laid out 2 px smaller inside a 1-px margin so the shift never clips a glyph.
    const [dx, dy] = pixelShiftAt(nowMs, this.timing.pixelShiftPeriodMs);
    const layout = shiftLayout(layoutWidget(lines, width - 2, height - 2, STYLE), 1 + dx, 1 + dy);
    const bmp = composeLayout(layout, width, height);
    driver.sendSplashImage(wire, bmp, spec);
    this.deps.mirror?.(mk2, Buffer.from(bmp), 'bmp');
  }

  /** Clear the key on the panel and black out its preview. */
  private blank(driver: DockDriver, mk2: number): void {
    const wire = mk2IndexToDeviceImgId(mk2, driver.model);
    if (wire < 0) return;
    driver.clearKey(wire);
    if (this.deps.mirror)
      this.deps.mirror(mk2, Buffer.from(blackBmp(splashSpec(driver.model))), 'bmp');
  }
}

function blackBmp({ width, height }: DeviceImageSpec): Uint8Array {
  const key = `${width}x${height}`;
  let bmp = BLACK.get(key);
  if (!bmp) {
    bmp = composeLayout(layoutWidget([], width, height, STYLE), width, height);
    BLACK.set(key, bmp);
  }
  return bmp;
}
