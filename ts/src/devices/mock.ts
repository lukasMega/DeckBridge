import { EventEmitter } from 'node:events';
import type { DockDriver, DeviceImageSpec, DeviceModel, DeviceModelOverride } from './driver.js';
import type {
  DialEvent,
  KeyState,
  MockInput,
  TouchInputEvent,
  TouchStripOptions,
} from '../shared/types.js';
import { DEFAULT_TOUCH_STRIP_OPTIONS, MOCK_KEY_PRESS_DURATION_MS } from '../shared/types.js';

/** A virtual deck: no device to paint, so the worker-side calls are no-ops. */
export class MockDriver extends EventEmitter implements DockDriver {
  model: DeviceModel;
  readonly touchStripOptions: TouchStripOptions = DEFAULT_TOUCH_STRIP_OPTIONS;

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
  clearKey(_keyIndex: number): void {}
  setBrightness(_level: number): void {}
  // ExtraKeyWidgets still paints (and mirrors the paints to the WebUI) in mock mode.
  sendSplashImage(_keyIndex: number, _bytes: Uint8Array, _spec: DeviceImageSpec): void {}
  renderCoraImage(_keyIndex: number, _bytes: Uint8Array, _format: 'jpeg' | 'bmp'): void {}
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
