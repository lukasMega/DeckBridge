import type { DeviceModel } from '../devices/driver.js';
import type { DemoDeck } from './deck.js';

export class MockDeck implements DemoDeck {
  readonly kind = 'mock';
  constructor(readonly model: DeviceModel) {}
  paintKey(_mk2Index: number, _icon: OffscreenCanvas | null): void {}
  setBrightness(_level: number): void {}
  close(): Promise<void> {
    return Promise.resolve();
  }
}
