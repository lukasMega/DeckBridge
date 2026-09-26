// Per-device preferences that live on the SELECTED dock's settings.json entry:
// the "ignore brightness from the Elgato app" flag.
//
// It falls back to a runtime-only value when there is no deviceKey yet (mock
// mode, or before the first connect) — that fallback is never persisted, since
// it belongs to no physical device.
import type { DeviceIdentitySettings, TapFeedback } from '../../settings-store.js';
import { tapFeedbackOf } from '../../settings-store.js';
import type { TouchStripMode } from '../../types.js';
import {
  DEFAULT_BRIGHTNESS_OVERRIDE,
  DEFAULT_TOUCH_STRIP_MODE,
  TOUCH_STRIP_REPAINT_DEFAULT_MS,
} from '../../types.js';
import type { ControllerHost, ReqError } from './types.js';

export class DevicePrefsController {
  private runtimeBrightnessOverride = DEFAULT_BRIGHTNESS_OVERRIDE;
  private runtimeTouchStripMode: TouchStripMode = DEFAULT_TOUCH_STRIP_MODE;
  private runtimeTouchStripRepaintMs = TOUCH_STRIP_REPAINT_DEFAULT_MS;

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

  /** Per-device touch-strip mode — also read by the widget scheduler
   *  (ExtraKeyWidgets) via DriverManager/DeviceSession. */
  touchStripModeFor(deviceKey: string): TouchStripMode {
    const e = this.host.settings.entryFor(deviceKey);
    return e ? (e.touchStripMode ?? DEFAULT_TOUCH_STRIP_MODE) : this.runtimeTouchStripMode;
  }

  /** touchStripMode of the SELECTED dock (WebUI mode selector). */
  get touchStripMode(): TouchStripMode {
    return this.touchStripModeFor(this.host.selectedDeviceKey());
  }

  /** Store, broadcast, and let app.ts hand the strip over via 'touchStripModeChanged'.
   *  409 when the selected dock has no strip — the mode would persist on a device it
   *  means nothing for. */
  trySetTouchStripMode(mode: TouchStripMode): ReqError | null {
    if (!this.host.selectedDockStatus()?.widgetDisplays?.length) {
      return { error: 'selected dock has no touch strip', status: 409 };
    }
    this.mutateSelectedEntryOrRuntime(
      (e) => (e.touchStripMode = mode),
      () => (this.runtimeTouchStripMode = mode),
    );
    this.host.broadcast('touchStripMode', { mode });
    this.host.emit('touchStripModeChanged', this.host.selectedDock(), mode);
    return null;
  }

  /** Per-device repaint hold-off — read live by ExtraKeyWidgets each tick,
   *  so a change needs no event to reach the dock. */
  touchStripRepaintMsFor(deviceKey: string): number {
    const e = this.host.settings.entryFor(deviceKey);
    return e
      ? (e.touchStripRepaintMs ?? TOUCH_STRIP_REPAINT_DEFAULT_MS)
      : this.runtimeTouchStripRepaintMs;
  }

  /** Per-device tap-refresh feedback (settings.json only), read live per tap. */
  tapFeedbackFor(deviceKey: string): TapFeedback {
    return tapFeedbackOf(this.host.settings.entryFor(deviceKey));
  }

  get touchStripRepaintMs(): number {
    return this.touchStripRepaintMsFor(this.host.selectedDeviceKey());
  }

  /** The SELECTED dock's strip fields for /api/state. */
  touchStripState(): { touchStripMode: TouchStripMode; touchStripRepaintMs: number } {
    return { touchStripMode: this.touchStripMode, touchStripRepaintMs: this.touchStripRepaintMs };
  }

  /** 409 without a strip, same as trySetTouchStripMode. */
  trySetTouchStripRepaintMs(ms: number): ReqError | null {
    if (!this.host.selectedDockStatus()?.widgetDisplays?.length) {
      return { error: 'selected dock has no touch strip', status: 409 };
    }
    this.mutateSelectedEntryOrRuntime(
      (e) => (e.touchStripRepaintMs = ms),
      () => (this.runtimeTouchStripRepaintMs = ms),
    );
    this.host.broadcast('touchStripRepaint', { ms });
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

  /** Broadcast-only: brightness is persisted per-device via notifyDocks; this
   *  just pushes the slider value. */
  broadcastBrightness(level: number): void {
    this.host.broadcast('brightness', { level });
  }

  /** Push the SELECTED dock's per-device values to WS clients (after a dock
   *  switch or a settings import) — none of them are in the status snapshot. */
  broadcastSelected(extraKeyConfigs: unknown): void {
    this.host.broadcast('brightnessOverride', { enabled: this.brightnessOverride });
    this.host.broadcast('extraKeys', { configs: extraKeyConfigs });
    this.host.broadcast('touchStripMode', { mode: this.touchStripMode });
    this.host.broadcast('touchStripRepaint', { ms: this.touchStripRepaintMs });
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
