// A DockDriver whose every call is a no-op: test fakes extend it and override only
// what they record. Not a MockDriver on purpose — a Dock wires a MockDriver as the
// virtual deck (no key map, no splash), and these fakes stand in for USB workers.
import { EventEmitter } from '../../src/platform/events-shim.js';
import type {
  DeviceImageSpec,
  DeviceModel,
  DeviceModelOverride,
  DockDriver,
} from '../../src/devices/driver.js';
import { DEFAULT_TOUCH_STRIP_OPTIONS } from '../../src/shared/types.js';
import type { TouchStripOptions, TouchWindowRegion } from '../../src/shared/types.js';

export class StubDockDriver extends EventEmitter implements DockDriver {
  model: DeviceModel;
  touchStripOptions: TouchStripOptions = DEFAULT_TOUCH_STRIP_OPTIONS;

  constructor(model: DeviceModel) {
    super();
    this.model = model;
  }

  open(_hidPath?: string): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
  clearKey(_keyIndex: number): void {}
  setBrightness(_level: number): void {}
  renderCoraImage(_keyIndex: number, _bytes: Uint8Array, _format: 'jpeg' | 'bmp'): void {}
  sendSplashImage(_keyIndex: number, _bytes: Uint8Array, _spec: DeviceImageSpec): void {}
  renderTouchImage(_bytes: Uint8Array, _region?: TouchWindowRegion): void {}
  setTouchStripMask(_wireIds: readonly number[]): void {}
  restoreTouchSegments(_wireIds: readonly number[]): void {}
  setTouchStripOptions(options: TouchStripOptions): void {
    this.touchStripOptions = options;
  }
  applyOverrides(_overrides: DeviceModelOverride | undefined, effectiveModel: DeviceModel): void {
    this.model = effectiveModel;
  }
  setLogLevel(_level: string): void {}
}
