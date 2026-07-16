// Extra-keys panel — configure the display widgets on the selected dock's keys
// outside the emulated grid (293S 6th column, top→bottom). Those keys have no
// switches; the server renders their content (clock/date/text/weather) and
// refreshes it itself, so this panel only picks the widget + its parameter.
import { useEffect, useRef, useState } from 'preact/hooks';
import { useStore } from '../store.js';
import type { ExtraKeyCfg, ExtraKeyWidget, PluginStatus, PluginsInfo } from '../ui-types.js';
import { ICON } from '../ui-icons.js';
import { Icon } from './Icon.js';

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
const PARAM_MAX = 128; // mirrors EXTRA_KEY_PARAM_MAX (types.ts)

// Command widget re-run interval / kill-timeout bounds — mirrors
// COMMAND_INTERVAL_*_MS / COMMAND_TIMEOUT_*_MS (types.ts), in seconds for the UI.
const INTERVAL_MIN_S = 1;
const INTERVAL_MAX_S = 3600;
const INTERVAL_DEFAULT_S = 10;
const TIMEOUT_MIN_S = 1;
const TIMEOUT_MAX_S = 60;
const TIMEOUT_DEFAULT_S = 5;
// Plugin widget re-poll default — mirrors PLUGIN_INTERVAL_DEFAULT_MS (types.ts),
// in seconds. Bounds reuse INTERVAL_MIN_S/INTERVAL_MAX_S (same server validation).
const PLUGIN_INTERVAL_DEFAULT_S = 5;
// Sentinel <option> value for "Custom path…" in the plugin file dropdown.
const PLUGIN_CUSTOM = '__custom__';
// Status line refresh cadence while a plugin popover is open (ms).
const PLUGIN_STATUS_POLL_MS = 2000;

function postExtraKey(
  wireId: number,
  widget: ExtraKeyWidget,
  param?: string,
  intervalMs?: number,
  timeoutMs?: number,
  pluginArg?: string,
): void {
  fetch('/api/extra-key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      wireId,
      widget,
      ...(param ? { param } : {}),
      ...(intervalMs !== undefined ? { intervalMs } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(pluginArg !== undefined ? { pluginArg } : {}),
    }),
  }).catch(() => undefined);
}

function runExtraKeyNow(wireId: number): void {
  fetch('/api/extra-key/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wireId }),
  }).catch(() => undefined);
}

function paramPlaceholder(widget: ExtraKeyWidget): string {
  if (widget === 'weather') return 'lat,lon e.g. 50.08,14.43';
  if (widget === 'command') return 'shell command e.g. date +%H:%M';
  return 'text (\\n = new line)';
}

/** Small popup, anchored under the gear button, to edit a command widget's
 *  re-run interval / kill-timeout and to force an immediate run. Closes on
 *  Escape or an outside click — no scrim/dim, it sits right by the trigger. */
function CommandConfigPopover({
  wireId,
  cfg,
  anchorRef,
  onClose,
}: Readonly<{
  wireId: number;
  cfg?: ExtraKeyCfg;
  anchorRef: { current: HTMLDivElement | null };
  onClose: () => void;
}>): preact.JSX.Element {
  // anchorRef spans the gear button + this popup — a pointerdown on the
  // button itself must not count as "outside" (it already toggles via onClick).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    const onPointerDown = (e: PointerEvent): void => {
      if (anchorRef.current && !anchorRef.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [onClose, anchorRef]);

  const [ran, setRan] = useState(false);
  const intervalS = Math.round((cfg?.intervalMs ?? INTERVAL_DEFAULT_S * 1000) / 1000);
  const timeoutS = Math.round((cfg?.timeoutMs ?? TIMEOUT_DEFAULT_S * 1000) / 1000);

  const handleInterval = (e: Event): void => {
    const s = Number((e.target as HTMLInputElement).value);
    if (!Number.isFinite(s) || s < INTERVAL_MIN_S || s > INTERVAL_MAX_S) return;
    postExtraKey(wireId, 'command', cfg?.param, Math.round(s * 1000), cfg?.timeoutMs);
  };
  const handleTimeout = (e: Event): void => {
    const s = Number((e.target as HTMLInputElement).value);
    if (!Number.isFinite(s) || s < TIMEOUT_MIN_S || s > TIMEOUT_MAX_S) return;
    postExtraKey(wireId, 'command', cfg?.param, cfg?.intervalMs, Math.round(s * 1000));
  };
  const handleRunNow = (): void => {
    runExtraKeyNow(wireId);
    setRan(true);
  };

  return (
    <div class="xkey-popover">
      <label class="xkey-popover-field">
        <span>Run every (s)</span>
        <input
          type="number"
          min={INTERVAL_MIN_S}
          max={INTERVAL_MAX_S}
          value={intervalS}
          onChange={handleInterval}
        />
      </label>
      <label class="xkey-popover-field">
        <span>Timeout (s)</span>
        <input
          type="number"
          min={TIMEOUT_MIN_S}
          max={TIMEOUT_MAX_S}
          value={timeoutS}
          onChange={handleTimeout}
        />
      </label>
      <button class="ghostbtn xkey-popover-run" type="button" onClick={handleRunNow}>
        {ran ? 'Ran ✓' : 'Run now'}
      </button>
    </div>
  );
}

const STATUS_LABEL: Record<PluginStatus, string> = {
  pending: 'pending',
  ok: 'ok',
  err: 'ERR',
  disabled: 'disabled',
};

/** Gear popover for a plugin widget: the per-key argument (ctx.param), the
 *  re-poll interval (same UI pattern as the command widget), and a live status
 *  line for the selected key. Dismiss on Escape / outside click. */
function PluginConfigPopover({
  wireId,
  cfg,
  status,
  anchorRef,
  onClose,
}: Readonly<{
  wireId: number;
  cfg?: ExtraKeyCfg;
  status?: PluginStatus;
  anchorRef: { current: HTMLDivElement | null };
  onClose: () => void;
}>): preact.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    const onPointerDown = (e: PointerEvent): void => {
      if (anchorRef.current && !anchorRef.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [onClose, anchorRef]);

  const intervalS = Math.round((cfg?.intervalMs ?? PLUGIN_INTERVAL_DEFAULT_S * 1000) / 1000);
  const handleInterval = (e: Event): void => {
    const s = Number((e.target as HTMLInputElement).value);
    if (!Number.isFinite(s) || s < INTERVAL_MIN_S || s > INTERVAL_MAX_S) return;
    postExtraKey(wireId, 'plugin', cfg?.param, Math.round(s * 1000), undefined, cfg?.pluginArg);
  };
  // Local state owns the arg field while the popover is open — the panel's 2s
  // status poll re-renders this component, and a controlled value bound to
  // cfg.pluginArg would clobber uncommitted typing on every poll tick.
  const [arg, setArg] = useState(cfg?.pluginArg ?? '');
  const handleArg = (e: Event): void => {
    postExtraKey(
      wireId,
      'plugin',
      cfg?.param,
      cfg?.intervalMs,
      undefined,
      (e.target as HTMLInputElement).value,
    );
  };
  const st = status ?? 'pending';

  return (
    <div class="xkey-popover">
      <label class="xkey-popover-field xkey-popover-arg">
        <span>Argument</span>
        <input
          type="text"
          maxLength={PARAM_MAX}
          value={arg}
          placeholder="passed as ctx.param"
          onInput={(e) => setArg((e.target as HTMLInputElement).value)}
          onChange={handleArg}
        />
      </label>
      <label class="xkey-popover-field">
        <span>Run every (s)</span>
        <input
          type="number"
          min={INTERVAL_MIN_S}
          max={INTERVAL_MAX_S}
          value={intervalS}
          onChange={handleInterval}
        />
      </label>
      <div class="xkey-popover-status">
        Status: <span class={`xkey-status xkey-status-${st}`}>{STATUS_LABEL[st]}</span>
      </div>
    </div>
  );
}

const PARAM_NOUN: Partial<Record<ExtraKeyWidget, string>> = {
  weather: 'location',
  command: 'command',
};

// change (not input) — commits on blur/Enter, one POST per edit. Only the text
// widget maps a typed "\n" to a real line break; a command string must survive
// verbatim (a backslash-n could be part of the command).
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
      class="xkey-select xkey-param"
      type="text"
      maxLength={PARAM_MAX}
      value={isText ? param.replaceAll('\n', '\\n') : param}
      placeholder={paramPlaceholder(widget)}
      aria-label={`${label} side key ${PARAM_NOUN[widget] ?? 'text'}`}
      onChange={handleParam}
    />
  );
}

// Plugin file picker: "Custom path…" swaps the dropdown for an absolute-path
// input. A param containing a path separator IS a custom path (the server
// resolves bare names against the plugins dir, absolute paths as-is).
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
      return; // nothing to POST until a path is typed
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
        class={customActive ? 'xkey-select' : 'xkey-select xkey-param'}
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
          class="xkey-select xkey-param"
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

function ConfigButton({
  wireId,
  label,
  widget,
  cfg,
  pluginStatus,
}: Readonly<{
  wireId: number;
  label: string;
  widget: ExtraKeyWidget;
  cfg?: ExtraKeyCfg;
  pluginStatus?: PluginStatus;
}>): preact.JSX.Element {
  const [showConfig, setShowConfig] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  return (
    <div class="xkey-config-anchor" ref={anchorRef}>
      <button
        class="xkey-config-btn"
        type="button"
        aria-label={`${label} side key ${widget} settings`}
        onClick={() => setShowConfig((v) => !v)}
      >
        <Icon html={ICON.gear} />
      </button>
      {showConfig && widget === 'command' && (
        <CommandConfigPopover
          wireId={wireId}
          cfg={cfg}
          anchorRef={anchorRef}
          onClose={() => setShowConfig(false)}
        />
      )}
      {showConfig && widget === 'plugin' && (
        <PluginConfigPopover
          wireId={wireId}
          cfg={cfg}
          status={pluginStatus}
          anchorRef={anchorRef}
          onClose={() => setShowConfig(false)}
        />
      )}
    </div>
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
        class="xkey-select"
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

/** Renders nothing unless the selected dock has extra keys (real mode only —
 *  mock docks have no persisted per-device settings to store the config in). */
export function ExtraKeysPanel(): preact.JSX.Element | null {
  const status = useStore((s) => s.status);
  const configs = useStore((s) => s.extraKeys);

  // Plugin dropdown data + live per-key status. One fetch on mount; while any
  // key runs a plugin widget, re-poll so the popover's status line stays live.
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
