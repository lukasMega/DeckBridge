// Configure display widgets on selected dock's extra keys (293S 6th column).
// These keys have no switches; the server renders content and refreshes it,
// so this panel only picks the widget + its parameter.
import { useEffect, useState } from 'preact/hooks';
import { useStore } from '../store.js';
import type { ExtraKeyCfg, ExtraKeyWidget, PluginStatus, PluginsInfo } from '../ui-types.js';
import { ConfigButton, paramPlaceholder, postExtraKey, PARAM_MAX } from './extra-keys-popovers.js';

const WIDGET_OPTIONS: ReadonlyArray<{ value: ExtraKeyWidget; label: string }> = [
  { value: 'none', label: 'Empty' },
  { value: 'clock', label: 'Clock (24h)' },
  { value: 'date', label: 'Date' },
  { value: 'text', label: 'Custom text' },
  { value: 'weather', label: 'Weather (°C)' },
  { value: 'command', label: 'Command output' },
  { value: 'plugin', label: 'Plugin (JS)' },
];

const POSITION_LABELS = ['Top', 'Middle', 'Bottom'];
const PLUGIN_CUSTOM = '__custom__';
const PLUGIN_STATUS_POLL_MS = 2000;

const PARAM_NOUN: Partial<Record<ExtraKeyWidget, string>> = {
  weather: 'location',
  command: 'command',
};

// change (not input) — commits on blur/Enter. Only text widget maps "\n" to real line break.
function ParamInput({
  wireId,
  label,
  widget,
  param,
  cfg,
}: Readonly<{
  wireId: number;
  label: string;
  widget: ExtraKeyWidget;
  param: string;
  cfg?: ExtraKeyCfg;
}>): preact.JSX.Element {
  const isText = widget === 'text';
  const handleParam = (e: Event): void => {
    const raw = (e.target as HTMLInputElement).value;
    postExtraKey(
      wireId,
      widget,
      isText ? raw.replaceAll('\\n', '\n') : raw,
      cfg?.intervalMs,
      cfg?.timeoutMs,
    );
  };
  return (
    <input
      class="input xkey-select xkey-param"
      type="text"
      maxLength={PARAM_MAX}
      value={isText ? param.replaceAll('\n', '\\n') : param}
      placeholder={paramPlaceholder(widget)}
      aria-label={`${label} side key ${PARAM_NOUN[widget] ?? 'text'}`}
      onChange={handleParam}
    />
  );
}

// "Custom path…" swaps dropdown for absolute-path input. Server resolves bare
// names against plugins dir; absolute paths used as-is.
function PluginPicker({
  wireId,
  label,
  param,
  cfg,
  pluginFiles,
  pluginsDir,
}: Readonly<{
  wireId: number;
  label: string;
  param: string;
  cfg?: ExtraKeyCfg;
  pluginFiles: string[];
  pluginsDir: string;
}>): preact.JSX.Element {
  const [customMode, setCustomMode] = useState(false);
  const isCustomParam = param.includes('/') || param.includes('\\');
  const customActive = customMode || isCustomParam;

  const handlePluginFile = (e: Event): void => {
    const file = (e.target as HTMLSelectElement).value;
    if (file === PLUGIN_CUSTOM) {
      setCustomMode(true);
      return;
    }
    setCustomMode(false);
    postExtraKey(wireId, 'plugin', file || undefined, cfg?.intervalMs, undefined, cfg?.pluginArg);
  };
  const handleCustomPath = (e: Event): void => {
    const p = (e.target as HTMLInputElement).value.trim();
    if (p) postExtraKey(wireId, 'plugin', p, cfg?.intervalMs, undefined, cfg?.pluginArg);
  };

  return (
    <>
      <select
        class={customActive ? 'input xkey-select' : 'input xkey-select xkey-param'}
        value={customActive ? PLUGIN_CUSTOM : param}
        title={`plugins dir: ${pluginsDir}`}
        aria-label={`${label} side key plugin file`}
        onChange={handlePluginFile}
      >
        {!param && !customActive && (
          <option value="">
            {pluginFiles.length > 0 ? 'choose plugin…' : 'no plugins in dir'}
          </option>
        )}
        {!customActive && param && !pluginFiles.includes(param) && (
          <option value={param}>{param} (missing)</option>
        )}
        {pluginFiles.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
        <option value={PLUGIN_CUSTOM}>Custom path…</option>
      </select>
      {customActive && (
        <input
          class="input xkey-select xkey-param"
          type="text"
          maxLength={PARAM_MAX}
          value={isCustomParam ? param : ''}
          placeholder="/absolute/path/plugin.js"
          aria-label={`${label} side key plugin path`}
          onChange={handleCustomPath}
        />
      )}
    </>
  );
}

function ExtraKeyRow({
  wireId,
  label,
  cfg,
  pluginFiles,
  pluginsDir,
  pluginStatus,
}: Readonly<{
  wireId: number;
  label: string;
  cfg?: ExtraKeyCfg;
  pluginFiles: string[];
  pluginsDir: string;
  pluginStatus?: PluginStatus;
}>): preact.JSX.Element {
  const widget = cfg?.widget ?? 'none';
  const param = cfg?.param ?? '';
  const hasParam = widget === 'text' || widget === 'weather' || widget === 'command';
  const hasConfig = widget === 'command' || widget === 'plugin';

  const handleWidget = (e: Event): void => {
    const next = (e.target as HTMLSelectElement).value as ExtraKeyWidget;
    postExtraKey(
      wireId,
      next,
      next === widget ? param : undefined,
      cfg?.intervalMs,
      cfg?.timeoutMs,
    );
  };

  return (
    <div class="xkey-row">
      <span class="xkey-pos">{label}</span>
      <select
        class="input xkey-select"
        value={widget}
        aria-label={`${label} side key widget`}
        onChange={handleWidget}
      >
        {WIDGET_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hasParam && (
        <ParamInput wireId={wireId} label={label} widget={widget} param={param} cfg={cfg} />
      )}
      {widget === 'plugin' && (
        <PluginPicker
          wireId={wireId}
          label={label}
          param={param}
          cfg={cfg}
          pluginFiles={pluginFiles}
          pluginsDir={pluginsDir}
        />
      )}
      {hasConfig && (
        <ConfigButton
          wireId={wireId}
          label={label}
          widget={widget}
          cfg={cfg}
          pluginStatus={pluginStatus}
        />
      )}
    </div>
  );
}

// Renders nothing unless selected dock has extra keys in real mode.
export function ExtraKeysPanel(): preact.JSX.Element | null {
  const status = useStore((s) => s.status);
  const configs = useStore((s) => s.extraKeys);

  // Fetch plugin file list + live per-key status; re-poll while any key runs a plugin.
  const [plugins, setPlugins] = useState<PluginsInfo>({ dir: '', files: [], status: {} });
  const hasPlugin = Object.values(configs).some((c) => c.widget === 'plugin');
  useEffect(() => {
    let alive = true;
    const load = (): void => {
      fetch('/api/plugins')
        .then((r) => r.json())
        .then((info: PluginsInfo) => {
          if (alive) setPlugins(info);
          return undefined;
        })
        .catch(() => undefined);
    };
    load();
    const timer = hasPlugin ? setInterval(load, PLUGIN_STATUS_POLL_MS) : undefined;
    return () => {
      alive = false;
      if (timer !== undefined) clearInterval(timer);
    };
  }, [hasPlugin]);

  if (status.driverMode === 'mock') return null;
  const selected = status.selectedDock ?? 0;
  const dock = status.docks?.find((d) => d.index === selected) ?? status.docks?.[0];
  const wireIds = dock?.extraKeys;
  if (!wireIds || wireIds.length === 0) return null;

  const sorted = wireIds.toSorted((a, b) => a - b);
  return (
    <div class="xkeys">
      <div class="xkeys-head">
        <span class="xkeys-label">Side keys</span>
        <span class="xkeys-sub">The display-only right column — show a value on each key</span>
      </div>
      {sorted.map((wireId, i) => (
        <ExtraKeyRow
          key={wireId}
          wireId={wireId}
          label={sorted.length === 3 ? POSITION_LABELS[i]! : `Key ${wireId}`}
          cfg={configs[String(wireId)]}
          pluginFiles={plugins.files}
          pluginsDir={plugins.dir}
          pluginStatus={plugins.status[String(wireId)]}
        />
      ))}
    </div>
  );
}
