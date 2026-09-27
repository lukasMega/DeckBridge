import { EventEmitter } from 'node:events';
import type { DeviceDriver, DeviceImageSpec, DeviceModel, DeviceModelOverride } from './driver.js';
import type { DialEvent, KeyState, MockInput, TouchInputEvent } from '../shared/types.js';
import { MOCK_KEY_PRESS_DURATION_MS } from '../shared/types.js';

export class MockDriver extends EventEmitter implements DeviceDriver {
  model: DeviceModel;

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
  // Present so ExtraKeyWidgets paints (and mirrors them to the WebUI) in mock mode.
  sendSplashImage(_keyIndex: number, _bytes: Uint8Array, _spec: DeviceImageSpec): void {}

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
