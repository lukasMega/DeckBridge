import { EventEmitter } from 'node:events';
import { stripDisplays } from './driver.js';
import type { DockDriver, DeviceImageSpec, DeviceModel, DeviceModelOverride } from './driver.js';
import type {
  DialEvent,
  KeyState,
  MockInput,
  TouchInputEvent,
  TouchStripOptions,
  WideKeyHourFormat,
} from '../shared/types.js';
import { DEFAULT_TOUCH_STRIP_OPTIONS, MOCK_KEY_PRESS_DURATION_MS } from '../shared/types.js';
import { clampPercent } from '../shared/host-stats.js';
import type { HostStats } from '../shared/host-stats.js';
import { composeWidgetBmp } from '../shared/widget-raster.js';
import { hashJpeg } from '../shared/image-hash.js';
import { transformImageForDevice } from '../transform/translator.js';

/** A virtual deck: no USB writes, but strip widgets still feed the WebUI preview. */
export class MockDriver extends EventEmitter implements DockDriver {
  model: DeviceModel;
  readonly touchStripOptions: TouchStripOptions = DEFAULT_TOUCH_STRIP_OPTIONS;
  /** The last info-window mode pushed (null = never); tests and the WebUI mock read it. */
  smallWindow: { mode: number; hourFormat: WideKeyHourFormat } | null = null;
  /** The last host stats pushed for the info window's stats mode (null = never). */
  hostStats: HostStats | null = null;

  constructor(model: DeviceModel) {
    super();
    this.model = model;
  }

  /** Live device-tuning swap. No device to repaint — the mock only carries the
   *  model so status/diagnostics report the tuned values. */
  applyOverrides(_overrides: DeviceModelOverride | undefined, effectiveModel: DeviceModel): void {
    this.model = effectiveModel;
  }

  async open(_hidPath?: string): Promise<void> {}
  async close(): Promise<void> {}
  clearKey(keyIndex: number): void {
    const display = stripDisplays(this.model).find((d) => d.wireId === keyIndex);
    if (!display) return;
    this.sendSplashImage(
      keyIndex,
      composeWidgetBmp([], display.image.width, display.image.height, { background: '#000000' }),
      display.image,
    );
  }
  setBrightness(_level: number): void {}
  setSmallWindow(mode: number, hourFormat: WideKeyHourFormat): void {
    this.smallWindow = { mode, hourFormat };
  }
  setHostStats(cpu: number, mem: number, gpu: number): void {
    this.hostStats = { cpu: clampPercent(cpu), mem: clampPercent(mem), gpu: clampPercent(gpu) };
  }
  // Mirror a strip upload as the real AKP05 driver does; side keys use widgetPaint.
  sendSplashImage(keyIndex: number, bytes: Uint8Array, spec: DeviceImageSpec): void {
    if (!stripDisplays(this.model).some((d) => d.wireId === keyIndex)) return;
    this.emit('stripWrite', keyIndex, transformImageForDevice(bytes, spec), false);
  }
  // Hashed on main: mock mode is dev/test only, real drivers hash in the worker.
  renderCoraImage(keyIndex: number, bytes: Uint8Array, _format: 'jpeg' | 'bmp'): void {
    this.emit('frameHash', keyIndex, hashJpeg(bytes));
  }
  renderTouchImage(): void {}
  setTouchStripMask(): void {}
  restoreTouchSegments(): void {}
  setTouchStripOptions(): void {}
  setLogLevel(): void {}

  simulateKeyPress(keyIndex: number): void {
    this.pressAndRelease((state) => this.emit('key', { keyIndex, state }));
  }

  /** Press on an extra key, by its image wire id (as keyed in ExtraKeyConfig). */
  simulateExtraKey(wireId: number): void {
    this.pressAndRelease((state) => this.emit('extraKey', { wireId, state }));
  }

  simulateDial(event: DialEvent): void {
    this.emit('dial', event);
  }

  simulateTouch(event: TouchInputEvent): void {
    this.emit('touch', event);
  }

  simulate(input: MockInput): void {
    if (input.kind === 'extraKey') this.simulateExtraKey(input.wireId);
    else if (input.kind === 'dial') this.simulateDial(input.event);
    else this.simulateTouch(input.event);
  }

  private pressAndRelease(emit: (state: KeyState) => void): void {
    emit('down');
    setTimeout(() => emit('up'), MOCK_KEY_PRESS_DURATION_MS);
  }
}
