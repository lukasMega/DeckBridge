import type { DialEvent, TouchInputEvent } from '../shared/types.js';
import type { DeviceModel } from '../devices/driver.js';

export interface DeckEvents {
  key(mk2Index: number, state: 'down' | 'up'): void;
  lost(reason: string): void;
  dial?(event: DialEvent): void;
  touch?(event: TouchInputEvent): void;
}

export interface DemoDeck {
  readonly kind: 'mock' | 'hw';
  readonly model: DeviceModel;
  paintKey(mk2Index: number, icon: OffscreenCanvas | null): void;
  paintStrip?(zone: number, icon: OffscreenCanvas): void;
  setBrightness(level: number): void;
  close(): Promise<void>;
}
