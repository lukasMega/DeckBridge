// Extra-key config + plugin-widget data for the 293S 6th column (see extra-keys.ts).
// All methods operate on the SELECTED dock, resolved via the host callbacks passed in.
import { pluginsDir } from '../../settings-store.js';
import { listPluginFiles, pluginKeyStatus } from '../../plugin-host.js';
import type { PluginStatus } from '../../plugin-host.js';
import type { Broadcaster } from './broadcaster.js';
import type { ExtraKeyConfig } from '../../types.js';
import type { ControllerHost, PluginsInfo, ReqError } from './types.js';

export class ExtraKeysController {
  constructor(
    private readonly host: ControllerHost,
    private readonly bus: Broadcaster,
  ) {}

  /** Persisted extra-key config for one device wire id — read per tick by the widget schedulers
   *  in DriverManager/DeviceSession. */
  configFor(deviceKey: string, wireId: number): ExtraKeyConfig | undefined {
    return this.host.settings.entryFor(deviceKey)?.extraKeys?.[String(wireId)];
  }

  /** The SELECTED dock's extra-key config map (WebUI panel state). */
  selectedConfigs(): Record<string, ExtraKeyConfig> {
    return this.host.settings.entryFor(this.host.selectedDeviceKey())?.extraKeys ?? {};
  }

  private onSelectedDock(wireId: number): boolean {
    return this.host.selectedDockStatus()?.extraKeys?.includes(wireId) ?? false;
  }

  private noKeyError(wireId: number): ReqError {
    return { error: `selected dock has no extra key ${wireId}`, status: 400 };
  }

  /** Assign (or clear, with widget 'none') a widget on the SELECTED dock. Persists, pushes the
   *  new map to WS clients, and emits 'extraKeyChanged' so app.ts repaints that dock's widgets. */
  trySet(wireId: number, cfg: ExtraKeyConfig, selectedDock: number): ReqError | null {
    if (!this.onSelectedDock(wireId)) return this.noKeyError(wireId);
    const entry = this.host.settings.entryFor(this.host.selectedDeviceKey());
    if (!entry) return { error: 'no connected device to configure', status: 409 };
    const map = { ...entry.extraKeys };
    if (cfg.widget === 'none') delete map[String(wireId)];
    else map[String(wireId)] = cfg;
    if (Object.keys(map).length > 0) entry.extraKeys = map;
    else delete entry.extraKeys;
    this.host.settings.persist();
    this.bus.broadcast('extraKeys', { configs: this.selectedConfigs() });
    this.host.emit('extraKeyChanged', selectedDock);
    return null;
  }

  /** WebUI "Run now" — immediate re-run of a command-widget extra key, bypassing its interval. */
  tryRunNow(wireId: number, selectedDock: number): ReqError | null {
    if (!this.onSelectedDock(wireId)) return this.noKeyError(wireId);
    const cfg = this.configFor(this.host.selectedDeviceKey(), wireId);
    if (cfg?.widget !== 'command') {
      return { error: `extra key ${wireId} is not configured as a command widget`, status: 400 };
    }
    this.host.emit('extraKeyRunNow', selectedDock, wireId);
    return null;
  }

  /** Plugin dropdown data + live per-key status for the SELECTED dock (read-only — the poll
   *  loops run from the widget scheduler in extra-keys.ts). */
  async pluginsInfo(): Promise<PluginsInfo> {
    const dir = pluginsDir();
    const files = await listPluginFiles(dir);
    const status: Record<string, PluginStatus> = {};
    for (const [wireId, cfg] of Object.entries(this.selectedConfigs())) {
      if (cfg.widget === 'plugin' && cfg.param)
        status[wireId] = pluginKeyStatus(cfg.param, cfg.pluginArg);
    }
    return { dir, files, status };
  }
}
