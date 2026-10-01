// A DockDriver with no hardware: the panel is a browser page. Runs on the main thread
// like MockDriver but is compiled into release builds, so it imports no FFI.
import { EventEmitter } from 'node:events';
import type {
  DeviceImageSpec,
  DeviceModel,
  DeviceModelOverride,
  DockDriver,
} from '../../devices/driver.js';
import {
  BROWSER_DECK_PROFILES,
  type BrowserDeckProfile,
} from '../../devices/virtual/browser-deck-profiles.js';
import type { KeyState, TouchStripOptions } from '../../shared/types.js';
import { DEFAULT_BRIGHTNESS, DEFAULT_TOUCH_STRIP_OPTIONS } from '../../shared/types.js';
import type { DeckLayout } from '../../web/server/virtual-deck/deck-hub.js';

export type DeckFrame = { data: Uint8Array; format: 'jpeg' | 'bmp' };

/** Where the panel state goes: the DeckHub (structurally). */
export interface VirtualDeckSink {
  frame(key: number, data: Uint8Array, format: 'jpeg' | 'bmp'): void;
  clear(key: number): void;
  brightness(level: number): void;
}

export class VirtualDeckDriver extends EventEmitter implements DockDriver {
  readonly model: DeviceModel;
  readonly touchStripOptions: TouchStripOptions = DEFAULT_TOUCH_STRIP_OPTIONS;
  private readonly rotate: 0 | 180;
  private readonly profile: BrowserDeckProfile;
  private readonly screen = new Map<number, DeckFrame>();
  private level = DEFAULT_BRIGHTNESS;
  private sink: VirtualDeckSink | null = null;

  constructor(profile: BrowserDeckProfile) {
    super();
    this.profile = profile;
    this.model = BROWSER_DECK_PROFILES[profile].model;
    this.rotate = BROWSER_DECK_PROFILES[profile].rotate;
  }

  setSink(sink: VirtualDeckSink | null): void {
    this.sink = sink;
  }

  layout(): DeckLayout {
    return {
      profile: this.profile,
      columns: this.model.columns,
      rows: this.model.rows,
      keyCount: this.model.keyCount,
      rotate: this.rotate,
    };
  }

  /** What a page that connects now must show. */
  snapshot(): ReadonlyMap<number, DeckFrame> {
    return this.screen;
  }

  brightnessLevel(): number {
    return this.level;
  }

  /** A press from a page. The index is already an MK.2 index: no key map applies. */
  input(keyIndex: number, state: KeyState): void {
    this.emit('key', { keyIndex, state });
  }

  // Nothing to open: browsers come and go and the dock stays, so no 'disconnect' either.
  async open(_hidPath?: string): Promise<void> {}
  close(): Promise<void> {
    this.sink = null;
    return Promise.resolve();
  }

  // Runs on the CORA ACK path: keep it O(1) plus the sink's async socket writes.
  renderCoraImage(keyIndex: number, bytes: Uint8Array, format: 'jpeg' | 'bmp'): void {
    this.screen.set(keyIndex, { data: bytes, format });
    this.sink?.frame(keyIndex, bytes, format);
  }

  clearKey(keyIndex: number): void {
    this.screen.delete(keyIndex);
    this.sink?.clear(keyIndex);
  }

  setBrightness(level: number): void {
    this.level = level;
    this.sink?.brightness(level);
  }

  // The page shows its own "waiting" state instead of a splash; the rest is hardware-only.
  sendSplashImage(_keyIndex: number, _bytes: Uint8Array, _spec: DeviceImageSpec): void {}
  renderTouchImage(): void {}
  setTouchStripMask(): void {}
  restoreTouchSegments(): void {}
  setTouchStripOptions(): void {}
  applyOverrides(_overrides: DeviceModelOverride | undefined, _effectiveModel: DeviceModel): void {}
  setLogLevel(): void {}
}
