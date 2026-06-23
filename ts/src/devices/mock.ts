import { EventEmitter } from 'node:events';
import type { DeviceDriver, DeviceModel } from './driver.js';
import type { KeyState } from '../types.js';
import { MOCK_KEY_PRESS_DURATION_MS } from '../types.js';

export class MockDriver extends EventEmitter implements DeviceDriver {
  readonly model: DeviceModel;

  constructor(model: DeviceModel) {
    super();
    this.model = model;
  }

  async open(): Promise<void> {}
  async close(): Promise<void> {}
  sendImage(_keyIndex: number, _bytes: Uint8Array): void {}
  clearKey(_keyIndex: number): void {}
  setBrightness(_level: number): void {}

  simulateKeyPress(keyIndex: number): void {
    const down: { keyIndex: number; state: KeyState } = { keyIndex, state: 'down' };
    const up: { keyIndex: number; state: KeyState } = { keyIndex, state: 'up' };
    this.emit('key', down);
    setTimeout(() => this.emit('key', up), MOCK_KEY_PRESS_DURATION_MS);
  }
}
