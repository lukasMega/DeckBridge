// WebUI side of the Ulanzi D200 info window for the SELECTED dock: the settings view and
// the validated write. The dock applies a change live (app.ts 'wideKeyChanged').
import {
  pickWideKeyKeys,
  wideKeyChoices,
  wideKeyError,
  wideKeyPresses,
} from '../../shared/wide-key.js';
import type { HostStats } from '../../shared/host-stats.js';
import type { WideKeyConfig, WideKeyView } from '../../shared/types.js';
import type { ControllerHost, ReqError } from './types.js';

/** The figures a dock's info window shows now (app.ts wires it to the dock); undefined = none. */
export type WideKeyStatsFn = (dock: number) => HostStats | undefined;

export class WideKeyController {
  constructor(
    private readonly host: ControllerHost,
    private readonly liveStats: WideKeyStatsFn = () => undefined,
  ) {}

  private prefs() {
    return this.host.settings.for(this.host.selectedDeviceKey());
  }

  /** The selected model's firmware modes; empty when it has no info window. */
  private modes(): readonly number[] {
    return this.host.selectedDockStatus()?.smallWindowModes ?? [];
  }

  private static noWindow(): ReqError {
    return { error: 'selected dock has no info window', status: 409 };
  }

  view(): WideKeyView | ReqError {
    const modes = this.modes();
    if (modes.length === 0) return WideKeyController.noWindow();
    const dock = this.host.selectedDock();
    const config = this.prefs().wideKey();
    // Zeros before the first sample are still the figures the window shows.
    const stats = config.content === 'stats' ? this.liveStats(dock) : undefined;
    return {
      dock,
      config,
      ...wideKeyChoices(modes),
      presses: wideKeyPresses(),
      ...(stats && { stats }),
    };
  }

  /** Merge the posted keys into the stored ones, validate the whole against the model's
   *  modes, persist, tell the dock. `statsPlugin: ''` clears the plugin. */
  trySet(body: unknown): WideKeyView | ReqError {
    const modes = this.modes();
    if (modes.length === 0) return WideKeyController.noWindow();
    const incoming = (body as { config?: unknown } | null)?.config;
    if (typeof incoming !== 'object' || incoming === null || Array.isArray(incoming)) {
      return { error: 'config must be an object', status: 400 };
    }
    const merged: Partial<WideKeyConfig> = {
      ...this.prefs().wideKeyStored(),
      ...pickWideKeyKeys(incoming as Record<string, unknown>),
    };
    if ((incoming as { statsPlugin?: unknown }).statsPlugin === '') delete merged.statsPlugin;
    const invalid = wideKeyError(merged, modes);
    if (invalid) return { error: invalid, status: 400 };
    if (!this.prefs().setWideKey(merged)) {
      return { error: 'no connected device to configure', status: 409 };
    }
    this.host.emit('wideKeyChanged', this.host.selectedDock());
    return this.view();
  }
}
