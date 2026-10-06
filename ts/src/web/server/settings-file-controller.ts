// The settings.json file surface of the WebUI: export, open in the OS, raw-JSON
// import, and the multi-deck toggle that import can also flip. The write path
// itself is PersistedSettings (infra/settings.ts).
import type { Settings } from '../../infra/settings-store.js';
import type { LoggingController } from './logging-controller.js';
import type { ControllerHost } from './types.js';
import { DEFAULT_TOUCH_STRIP_MODE } from '../../shared/types.js';

export class SettingsFileController {
  constructor(
    private readonly host: ControllerHost,
    private readonly logging: LoggingController,
  ) {}

  json(): string {
    return this.host.settings.json();
  }

  openFile(): Promise<void> {
    return this.host.settings.openFile();
  }

  /** Persist the multi-deck opt-in and let app.ts push the new cap to DriverManager. */
  setMultiDeck(enabled: boolean): void {
    this.host.settings.setMultiDeck(enabled);
    this.host.emit('setMultiDeck', enabled);
  }

  /** Parse `raw`, validate it's an object, assign known fields, persist. Throws on malformed
   *  JSON/non-object; unknown/invalid individual fields are ignored (not fatal). */
  applyJson(raw: string): void {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('settings must be a JSON object');
    }
    const s = parsed as Settings;
    if (s.logLevel !== undefined) this.logging.trySetLevel(s.logLevel);
    // Multi-deck travels with the file: importing one that enables it must
    // actually raise the cap, not just persist the flag.
    if (typeof s.multiDeck === 'boolean') this.setMultiDeck(s.multiDeck);
    // Device tuning: invalid entries are dropped with a warn inside
    // importModelOverrides, never thrown — an imported file must not be able to
    // poison runtime state. '' = "all models", the sessions reopen either way.
    if (Object.hasOwn(parsed, 'modelOverrides')) {
      this.host.settings.importModelOverrides(s.modelOverrides);
      this.host.emit('modelOverridesChanged', '');
    }
    // devices[] first, so the selected dock's entry is in place before we (re)select + re-apply.
    if (this.host.settings.importDevices(s.devices)) {
      this.reapplySelectedDeviceLive();
      // No index: every dock's standby settings may have changed, not just the selected one.
      this.host.emit('standbyChanged');
      this.host.emit('pagesChanged');
    }
    // selectedDock is best-effort — an index absent on this host (file imported from a machine
    // with more docks) is ignored; trySelectDock() fires its own broadcast + reapply on change.
    if (typeof s.selectedDock === 'number' && Number.isInteger(s.selectedDock)) {
      if (!this.host.trySelectDock(s.selectedDock)) this.reapplySelectedDeviceLive();
    }
  }

  /** Push the selected dock's persisted brightness/override to its driver + WS clients
   *  (used after a settings import). */
  private reapplySelectedDeviceLive(): void {
    const idx = this.host.selectedDock();
    this.host.broadcastSelected();
    this.host.emit('extraKeyChanged', idx);
    const e = this.host.settings.entryFor(this.host.selectedDeviceKey());
    if (typeof e?.brightness === 'number') this.host.emit('setBrightness', e.brightness, idx);
    if (e) {
      this.host.emit('touchStripModeChanged', idx, e.touchStripMode ?? DEFAULT_TOUCH_STRIP_MODE);
    }
  }
}
