// WebUI side of standby / burn-in care for the SELECTED dock: the settings view and
// the validated write. sleepCommand / wakeCommand are settings.json-only: never sent
// to the browser, never written here (pickStandbyKeys drops them, stored ones survive).
import {
  formatHhmm,
  pickStandbyKeys,
  publicStandby,
  standbySettingsError,
} from '../../shared/standby-settings.js';
import type { StandbySettings, StandbyView } from '../../shared/types.js';
import type { ControllerHost, ReqError } from './types.js';

export class StandbyController {
  constructor(
    private readonly host: ControllerHost,
    private readonly now: () => number = Date.now,
  ) {}

  private prefs() {
    return this.host.settings.for(this.host.selectedDeviceKey());
  }

  view(): StandbyView {
    const stored = this.prefs().standbyStored();
    const caps = this.host.selectedDockStatus()?.standbyCaps;
    // The night window follows the host's clock, so show that one.
    const local = new Date(this.now());
    return {
      dock: this.host.selectedDock(),
      settings: publicStandby(this.prefs().standby()),
      serverTime: formatHhmm(local.getHours() * 60 + local.getMinutes()),
      canSleep: caps?.sleep ?? false,
      canShowClock: caps?.clock ?? true,
      hasCommands: Boolean(stored.sleepCommand || stored.wakeCommand),
    };
  }

  /** Merge the posted keys into the stored ones, validate the whole, persist, tell the dock. */
  trySet(body: unknown): { view: StandbyView } | ReqError {
    const incoming = (body as { settings?: unknown } | null)?.settings;
    if (typeof incoming !== 'object' || incoming === null || Array.isArray(incoming)) {
      return { error: 'settings must be an object', status: 400 };
    }
    const stored = this.prefs().standbyStored();
    const merged: Partial<StandbySettings> = {
      ...pickStandbyKeys(stored),
      ...(stored.sleepCommand ? { sleepCommand: stored.sleepCommand } : {}),
      ...(stored.wakeCommand ? { wakeCommand: stored.wakeCommand } : {}),
      ...pickStandbyKeys(incoming as Record<string, unknown>),
    };
    const invalid = standbySettingsError(merged);
    if (invalid) return { error: invalid, status: 400 };
    this.prefs().setStandby(merged);
    this.host.emit('standbyChanged', this.host.selectedDock());
    return { view: this.view() };
  }
}
