// Per-device preferences that live on the SELECTED dock's settings.json entry:
// the "ignore brightness from the Elgato app" flag and the image-fit override.
//
// Both fall back to a runtime-only value when there is no deviceKey yet (mock
// mode, or before the first connect) — that fallback is never persisted, since
// it belongs to no physical device.
import type { PersistedSettings } from './persisted-settings.js';
import type { DeviceIdentitySettings } from '../../settings-store.js';
import type { ImageModeOverride } from '../../types.js';
import { DEFAULT_BRIGHTNESS_OVERRIDE } from '../../types.js';

export class DevicePrefsController {
  private runtimeBrightnessOverride = DEFAULT_BRIGHTNESS_OVERRIDE;
  private runtimeImageModeOverride: ImageModeOverride = null;

  constructor(
    private readonly settings: PersistedSettings,
    private readonly selectedDeviceKey: () => string,
    private readonly selectedDock: () => number,
    private readonly selectedBrightness: () => number,
    private readonly broadcast: (event: string, payload: unknown) => void,
    private readonly emit: (event: string, ...args: unknown[]) => boolean,
  ) {}

  /** Per-device brightnessOverride — also read by DriverManager/DeviceSession's
   *  Elgato-brightness ignore (resolved per dock, not a global flag). */
  isBrightnessOverride(deviceKey: string): boolean {
    const e = this.settings.entryFor(deviceKey);
    return e
      ? (e.brightnessOverride ?? DEFAULT_BRIGHTNESS_OVERRIDE)
      : this.runtimeBrightnessOverride;
  }

  /** brightnessOverride of the SELECTED dock (WebUI toggle). */
  get brightnessOverride(): boolean {
    return this.isBrightnessOverride(this.selectedDeviceKey());
  }

  /** imageModeOverride of the SELECTED dock; null = model default. */
  get imageModeOverride(): ImageModeOverride {
    const e = this.settings.entryFor(this.selectedDeviceKey());
    return e ? (e.imageModeOverride ?? null) : this.runtimeImageModeOverride;
  }

  setBrightnessOverride(enabled: boolean): void {
    this.mutateSelectedEntryOrRuntime(
      (e) => (e.brightnessOverride = enabled),
      () => (this.runtimeBrightnessOverride = enabled),
    );
    this.broadcast('brightnessOverride', { enabled });
    // Re-assert brightness so a freshly enabled override wins over whatever Elgato last pushed.
    if (enabled) this.emit('setBrightness', this.selectedBrightness(), this.selectedDock());
  }

  /** Store, broadcast, and let app.ts apply it via 'setImageOverride'. */
  setImageMode(mode: ImageModeOverride): void {
    this.mutateSelectedEntryOrRuntime(
      (e) => (e.imageModeOverride = mode),
      () => (this.runtimeImageModeOverride = mode),
    );
    this.broadcast('imageMode', { mode });
    this.emit('setImageOverride', mode, this.selectedDock());
  }

  /** Broadcast-only: brightness is persisted per-device via notifyDocks; this
   *  just pushes the slider value. */
  broadcastBrightness(level: number): void {
    this.broadcast('brightness', { level });
  }

  /** Push the SELECTED dock's per-device values to WS clients (after a dock
   *  switch or a settings import) — none of them are in the status snapshot. */
  broadcastSelected(extraKeyConfigs: unknown): void {
    this.broadcast('brightnessOverride', { enabled: this.brightnessOverride });
    this.broadcast('imageMode', { mode: this.imageModeOverride });
    this.broadcast('extraKeys', { configs: extraKeyConfigs });
  }

  /** Store a value on the SELECTED dock's persisted entry, or (no deviceKey) in
   *  the runtime-only fallback field. */
  private mutateSelectedEntryOrRuntime(
    mutate: (e: DeviceIdentitySettings) => void,
    runtimeFallback: () => void,
  ): void {
    const e = this.settings.entryFor(this.selectedDeviceKey());
    if (e) {
      mutate(e);
      this.settings.persist();
    } else {
      runtimeFallback();
    }
  }
}
