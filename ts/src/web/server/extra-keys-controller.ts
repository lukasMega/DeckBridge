// Extra-key config + plugin-widget data for keys outside the emulated grid (293S 6th
// column, AKP05E right column as a Stream Deck +) — see extra-keys.ts.
// All methods operate on the SELECTED dock, resolved via the host callbacks passed in.
import { pluginsDir } from '../../settings-store.js';
import { listPluginFiles, pluginKeyStatus } from '../../plugin-host.js';
import type { PluginStatus } from '../../plugin-host.js';
import type { Broadcaster } from './broadcaster.js';
import type { ExtraKeyConfig } from '../../types.js';
import type { WidgetPaint } from '../../widget-render.js';
import type { ExtraKeyPreviewResponse } from '../contract.js';
import { widgetPreviews } from './widget-preview.js';
import type {
  ControllerHost,
  ExtraKeyPressUpdate,
  ExtraKeyUpdate,
  PluginsInfo,
  ReqError,
} from './types.js';

/** The widget part of a config — `{ widget: 'none' }` when there is none yet. */
function withoutPress(cfg: ExtraKeyConfig | undefined): ExtraKeyConfig {
  const widget: ExtraKeyConfig = { ...(cfg ?? { widget: 'none' }) };
  delete widget.pressCommand;
  delete widget.pressAction;
  return widget;
}

/** `prev` with `update` applied — the widget and the press side (command + action)
 *  replace independently. undefined = nothing left to persist. */
function mergeExtraKey(
  prev: ExtraKeyConfig | undefined,
  update: ExtraKeyUpdate,
): ExtraKeyConfig | undefined {
  const press: ExtraKeyPressUpdate = 'widget' in update ? {} : update;
  const widget = withoutPress('widget' in update ? update : prev);
  const pressCommand = (press.pressCommand ?? prev?.pressCommand)?.trim();
  const pressAction = press.pressAction ?? prev?.pressAction;
  if (widget.widget === 'none' && !pressCommand && !pressAction) return undefined;
  return {
    ...widget,
    ...(pressCommand ? { pressCommand } : {}),
    ...(pressAction ? { pressAction } : {}),
  };
}

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
    const status = this.host.selectedDockStatus();
    return (
      status?.extraKeys?.includes(wireId) ||
      status?.widgetDisplays?.some((display) => display.wireId === wireId) ||
      false
    );
  }

  private noKeyError(wireId: number): ReqError {
    return { error: `selected dock has no extra key ${wireId}`, status: 400 };
  }

  /** Assign (or clear, with widget 'none') a widget, or set the press command, on the SELECTED
   *  dock. The two are independent: a widget change keeps the press command and vice versa.
   *  Persists, pushes the new map to WS clients, and on a widget change emits 'extraKeyChanged'
   *  so app.ts repaints that dock's widgets (a press command resolves per press). */
  trySet(wireId: number, update: ExtraKeyUpdate, selectedDock: number): ReqError | null {
    if (!this.onSelectedDock(wireId)) return this.noKeyError(wireId);
    const isWidget = 'widget' in update;
    if (!isWidget && !this.host.selectedDockStatus()?.pressableExtraKeys?.includes(wireId)) {
      return { error: `extra key ${wireId} has no switch`, status: 400 };
    }
    const entry = this.host.settings.entryFor(this.host.selectedDeviceKey());
    if (!entry) return { error: 'no connected device to configure', status: 409 };
    const map = { ...entry.extraKeys };
    const next = mergeExtraKey(map[String(wireId)], update);
    if (next) map[String(wireId)] = next;
    else delete map[String(wireId)];
    if (Object.keys(map).length > 0) entry.extraKeys = map;
    else delete entry.extraKeys;
    this.host.settings.persist();
    this.bus.broadcast('extraKeys', { configs: this.selectedConfigs() });
    if (isWidget) this.host.emit('extraKeyChanged', selectedDock);
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

  /** Text-size picker thumbnails for one of the SELECTED dock's widgets, from its last paint. */
  tryPreview(wireId: number, paint: WidgetPaint | undefined): ExtraKeyPreviewResponse | ReqError {
    if (!this.onSelectedDock(wireId)) return this.noKeyError(wireId);
    if (!paint) return { error: 'nothing painted on this key yet', status: 404 };
    return { wireId, previews: widgetPreviews(paint) };
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
