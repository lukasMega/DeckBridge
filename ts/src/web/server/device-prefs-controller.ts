// Per-device preferences that live on the SELECTED dock's settings.json entry:
// the "ignore brightness from the Elgato app" flag and the image-fit override.
//
// Both fall back to a runtime-only value when there is no deviceKey yet (mock
// mode, or before the first connect) — that fallback is never persisted, since
// it belongs to no physical device.
import type { DeviceIdentitySettings } from '../../settings-store.js';
import type { ImageModeOverride } from '../../types.js';
import { DEFAULT_BRIGHTNESS_OVERRIDE } from '../../types.js';
import type { ControllerHost, ReqError } from './types.js';

export class DevicePrefsController {
  private runtimeBrightnessOverride = DEFAULT_BRIGHTNESS_OVERRIDE;
  private runtimeImageModeOverride: ImageModeOverride = null;
  private runtimeTouchStripDisabled = false;

  constructor(
    private readonly host: ControllerHost,
    private readonly selectedBrightness: () => number,
  ) {}

  /** Per-device brightnessOverride — also read by DriverManager/DeviceSession's
   *  Elgato-brightness ignore (resolved per dock, not a global flag). */
  isBrightnessOverride(deviceKey: string): boolean {
    const e = this.host.settings.entryFor(deviceKey);
    return e
      ? (e.brightnessOverride ?? DEFAULT_BRIGHTNESS_OVERRIDE)
      : this.runtimeBrightnessOverride;
  }

  /** brightnessOverride of the SELECTED dock (WebUI toggle). */
  get brightnessOverride(): boolean {
    return this.isBrightnessOverride(this.host.selectedDeviceKey());
  }

  /** imageModeOverride of the SELECTED dock; null = model default. */
  get imageModeOverride(): ImageModeOverride {
    const e = this.host.settings.entryFor(this.host.selectedDeviceKey());
    return e ? (e.imageModeOverride ?? null) : this.runtimeImageModeOverride;
  }

  /** Per-device touch-strip disable — also read by the widget scheduler
   *  (ExtraKeyWidgets) via DriverManager/DeviceSession. */
  isTouchStripDisabled(deviceKey: string): boolean {
    const e = this.host.settings.entryFor(deviceKey);
    return e ? (e.touchStripDisabled ?? false) : this.runtimeTouchStripDisabled;
  }

  /** touchStripDisabled of the SELECTED dock (WebUI switch). */
  get touchStripDisabled(): boolean {
    return this.isTouchStripDisabled(this.host.selectedDeviceKey());
  }

  /** Store, broadcast, and let app.ts hand the strip to the Elgato app via
   *  'touchStripChanged'. 409 when the selected dock has no strip — the flag would
   *  persist on a device it means nothing for. */
  trySetTouchStripDisabled(disabled: boolean): ReqError | null {
    if (!this.host.selectedDockStatus()?.widgetDisplays?.length) {
      return { error: 'selected dock has no touch strip', status: 409 };
    }
    this.mutateSelectedEntryOrRuntime(
      (e) => (e.touchStripDisabled = disabled),
      () => (this.runtimeTouchStripDisabled = disabled),
    );
    this.host.broadcast('touchStrip', { disabled });
    this.host.emit('touchStripChanged', this.host.selectedDock(), disabled);
    return null;
  }

  setBrightnessOverride(enabled: boolean): void {
    this.mutateSelectedEntryOrRuntime(
      (e) => (e.brightnessOverride = enabled),
      () => (this.runtimeBrightnessOverride = enabled),
    );
    this.host.broadcast('brightnessOverride', { enabled });
    // Re-assert brightness so a freshly enabled override wins over whatever Elgato last pushed.
    if (enabled)
      this.host.emit('setBrightness', this.selectedBrightness(), this.host.selectedDock());
  }

  /** Store, broadcast, and let app.ts apply it via 'setImageOverride'. */
  setImageMode(mode: ImageModeOverride): void {
    this.mutateSelectedEntryOrRuntime(
      (e) => (e.imageModeOverride = mode),
      () => (this.runtimeImageModeOverride = mode),
    );
    this.host.broadcast('imageMode', { mode });
    this.host.emit('setImageOverride', mode, this.host.selectedDock());
  }

  /** Broadcast-only: brightness is persisted per-device via notifyDocks; this
   *  just pushes the slider value. */
  broadcastBrightness(level: number): void {
    this.host.broadcast('brightness', { level });
  }

  /** Push the SELECTED dock's per-device values to WS clients (after a dock
   *  switch or a settings import) — none of them are in the status snapshot. */
  broadcastSelected(extraKeyConfigs: unknown): void {
    this.host.broadcast('brightnessOverride', { enabled: this.brightnessOverride });
    this.host.broadcast('imageMode', { mode: this.imageModeOverride });
    this.host.broadcast('extraKeys', { configs: extraKeyConfigs });
    this.host.broadcast('touchStrip', { disabled: this.touchStripDisabled });
  }

  /** Store a value on the SELECTED dock's persisted entry, or (no deviceKey) in
   *  the runtime-only fallback field. */
  private mutateSelectedEntryOrRuntime(
    mutate: (e: DeviceIdentitySettings) => void,
    runtimeFallback: () => void,
  ): void {
    const e = this.host.settings.entryFor(this.host.selectedDeviceKey());
    if (e) {
      mutate(e);
      this.host.settings.persist();
    } else {
      runtimeFallback();
    }
  }
}
