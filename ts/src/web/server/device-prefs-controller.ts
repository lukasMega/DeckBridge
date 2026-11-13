// The SELECTED dock's per-device preferences (brightness override, touch strip),
// read and written through its DockPrefs — see infra/dock-prefs.ts.
import type { DockPrefs } from '../../infra/dock-prefs.js';
import type { ExtraKeyConfig, TouchStripMode } from '../../shared/types.js';
import type { ControllerHost, ReqError } from './types.js';

export class DevicePrefsController {
  constructor(
    private readonly host: ControllerHost,
    private readonly selectedBrightness: () => number,
  ) {}

  private get prefs(): DockPrefs {
    return this.host.settings.for(this.host.selectedDeviceKey());
  }

  get brightnessOverride(): boolean {
    return this.prefs.brightnessOverride();
  }

  get touchStripMode(): TouchStripMode {
    return this.prefs.stripMode();
  }

  get touchStripRepaintMs(): number {
    return this.prefs.repaintMs();
  }

  private hasStrip(): boolean {
    return !!this.host.selectedDockStatus()?.widgetDisplays?.length;
  }

  /** Store, broadcast, and let app.ts hand the strip over via 'touchStripModeChanged'.
   *  409 when the selected dock has no strip — the mode would persist on a device it
   *  means nothing for. */
  trySetTouchStripMode(mode: TouchStripMode): ReqError | null {
    if (!this.hasStrip()) return { error: 'selected dock has no touch strip', status: 409 };
    this.prefs.setStripMode(mode);
    this.host.broadcast('touchStripMode', { mode });
    this.host.emit('touchStripModeChanged', this.host.selectedDock(), mode);
    return null;
  }

  /** The SELECTED dock's strip fields for /api/state. */
  touchStripState(): { touchStripMode: TouchStripMode; touchStripRepaintMs: number } {
    return { touchStripMode: this.touchStripMode, touchStripRepaintMs: this.touchStripRepaintMs };
  }

  /** 409 without a strip, same as trySetTouchStripMode. No event: the widgets read it live. */
  trySetTouchStripRepaintMs(ms: number): ReqError | null {
    if (!this.hasStrip()) return { error: 'selected dock has no touch strip', status: 409 };
    this.prefs.setRepaintMs(ms);
    this.host.broadcast('touchStripRepaint', { ms });
    return null;
  }

  setBrightnessOverride(enabled: boolean): void {
    this.prefs.setBrightnessOverride(enabled);
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
  broadcastSelected(extraKeyConfigs: Record<string, ExtraKeyConfig>): void {
    this.host.broadcast('brightnessOverride', { enabled: this.brightnessOverride });
    this.host.broadcast('extraKeys', { configs: extraKeyConfigs });
    this.host.broadcast('touchStripMode', { mode: this.touchStripMode });
    this.host.broadcast('touchStripRepaint', { ms: this.touchStripRepaintMs });
  }
}
