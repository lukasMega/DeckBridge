// Per-key widget controls shared by the touch-strip rows and the side-key cards:
// widget select, its value input (text/location/command/plugin), the config
// popover button, and the press command.
import { useState } from 'preact/hooks';
import type { ExtraKeyCfg, ExtraKeyWidget, PluginStatus } from '../ui-types.js';
import { ConfigButton, paramPlaceholder, postExtraKey, PARAM_MAX } from './extra-keys-popovers.js';
import { CommandInput } from './command-input.js';
import { fire } from '../ui-api.js';

const WIDGET_OPTIONS: ReadonlyArray<{ value: ExtraKeyWidget; label: string }> = [
  { value: 'none', label: 'Empty' },
  { value: 'clock', label: 'Clock (24h)' },
  { value: 'date', label: 'Date' },
  { value: 'text', label: 'Custom text' },
  { value: 'weather', label: 'Weather (°C)' },
  { value: 'command', label: 'Command output' },
  { value: 'plugin', label: 'Plugin (JS)' },
];

const PLUGIN_CUSTOM = '__custom__';

const PARAM_NOUN: Partial<Record<ExtraKeyWidget, string>> = {
  weather: 'location',
  command: 'command',
};

export interface PluginFiles {
  files: string[];
  dir: string;
}

/** Widget has a value input or a config popover (i.e. more than the select). */
export function hasWidgetValue(widget: ExtraKeyWidget): boolean {
  return widget !== 'none' && widget !== 'clock' && widget !== 'date';
}

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
  plugins,
}: Readonly<{
  wireId: number;
  label: string;
  param: string;
  cfg?: ExtraKeyCfg;
  plugins: PluginFiles;
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
        title={`plugins dir: ${plugins.dir}`}
        aria-label={`${label} side key plugin file`}
        onChange={handlePluginFile}
      >
        {!param && !customActive && (
          <option value="">
            {plugins.files.length > 0 ? 'choose plugin…' : 'no plugins in dir'}
          </option>
        )}
        {!customActive && param && !plugins.files.includes(param) && (
          <option value={param}>{param} (missing)</option>
        )}
        {plugins.files.map((f) => (
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

export function WidgetSelect({
  wireId,
  label,
  cfg,
  noneLabel,
}: Readonly<{
  wireId: number;
  label: string;
  cfg?: ExtraKeyCfg;
  noneLabel?: string;
}>): preact.JSX.Element {
  const widget = cfg?.widget ?? 'none';
  const handleWidget = (e: Event): void => {
    const next = (e.target as HTMLSelectElement).value as ExtraKeyWidget;
    postExtraKey(
      wireId,
      next,
      next === widget ? (cfg?.param ?? '') : undefined,
      cfg?.intervalMs,
      cfg?.timeoutMs,
    );
  };
  return (
    <select
      class="input xkey-select"
      value={widget}
      aria-label={`${label} side key widget`}
      onChange={handleWidget}
    >
      {WIDGET_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.value === 'none' ? (noneLabel ?? o.label) : o.label}
        </option>
      ))}
    </select>
  );
}

/** Value track + config button; spans both tracks when the widget has no popover. */
export function WidgetValue({
  wireId,
  label,
  cfg,
  plugins,
  pluginStatus,
}: Readonly<{
  wireId: number;
  label: string;
  cfg?: ExtraKeyCfg;
  plugins: PluginFiles;
  pluginStatus?: PluginStatus;
}>): preact.JSX.Element {
  const widget = cfg?.widget ?? 'none';
  const param = cfg?.param ?? '';
  const hasParam = widget === 'text' || widget === 'weather' || widget === 'command';
  const hasConfig = widget === 'command' || widget === 'plugin';
  return (
    <>
      <div class={hasConfig ? 'xkey-value' : 'xkey-value xkey-wide'}>
        {hasParam && (
          <ParamInput wireId={wireId} label={label} widget={widget} param={param} cfg={cfg} />
        )}
        {widget === 'plugin' && (
          <PluginPicker wireId={wireId} label={label} param={param} cfg={cfg} plugins={plugins} />
        )}
      </div>
      {hasConfig && (
        <ConfigButton
          wireId={wireId}
          label={label}
          widget={widget}
          cfg={cfg}
          pluginStatus={pluginStatus}
        />
      )}
    </>
  );
}

export function PressCommandInput({
  wireId,
  label,
  cfg,
}: Readonly<{ wireId: number; label: string; cfg?: ExtraKeyCfg }>): preact.JSX.Element {
  return (
    <CommandInput
      value={cfg?.pressCommand ?? ''}
      label={`${label} side key press command`}
      placeholder="shell command"
      title="Shell command run on press"
      onCommit={(command) => fire('/api/extra-key/press', { wireId, command })}
    />
  );
}
