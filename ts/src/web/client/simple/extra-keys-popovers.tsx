import { useRef, useState } from 'preact/hooks';
import type { ExtraKeyCfg, ExtraKeyWidget, PluginStatus } from '../ui-types.js';
import { ICON } from '../ui-icons.js';
import { fire } from '../ui-api.js';
import { useDismiss } from '../ui-hooks.js';
import { Icon } from './Icon.js';

// Interval/timeout bounds mirror types.ts, in seconds for UI.
const INTERVAL_MIN_S = 1;
const INTERVAL_MAX_S = 3600;
const INTERVAL_DEFAULT_S = 10;
const TIMEOUT_MIN_S = 1;
const TIMEOUT_MAX_S = 60;
const TIMEOUT_DEFAULT_S = 5;
const PLUGIN_INTERVAL_DEFAULT_S = 5;
export const PARAM_MAX = 128; // mirrors EXTRA_KEY_PARAM_MAX (types.ts)

const STATUS_LABEL: Record<PluginStatus, string> = {
  pending: 'pending',
  ok: 'ok',
  err: 'ERR',
  disabled: 'disabled',
};

export function postExtraKey(
  wireId: number,
  widget: ExtraKeyWidget,
  param?: string,
  intervalMs?: number,
  timeoutMs?: number,
  pluginArg?: string,
): void {
  fire('/api/extra-key', {
    wireId,
    widget,
    ...(param ? { param } : {}),
    ...(intervalMs !== undefined ? { intervalMs } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(pluginArg !== undefined ? { pluginArg } : {}),
  });
}

function runExtraKeyNow(wireId: number): void {
  fire('/api/extra-key/run', { wireId });
}

export function paramPlaceholder(widget: ExtraKeyWidget): string {
  if (widget === 'weather') return 'lat,lon e.g. 50.08,14.43';
  if (widget === 'command') return 'shell command e.g. date +%H:%M';
  return 'text (\\n = new line)';
}

/** Seconds input that posts milliseconds. Out-of-range values are ignored rather
 *  than clamped — the number spinner would otherwise fight the user mid-typing. */
function SecondsField({
  label,
  min,
  max,
  value,
  onCommit,
}: Readonly<{
  label: string;
  min: number;
  max: number;
  value: number;
  onCommit: (ms: number) => void;
}>): preact.JSX.Element {
  const handleChange = (e: Event): void => {
    const s = Number((e.target as HTMLInputElement).value);
    if (!Number.isFinite(s) || s < min || s > max) return;
    onCommit(Math.round(s * 1000));
  };

  return (
    <label class="xkey-popover-field">
      <span>{label}</span>
      <input
        class="input"
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={handleChange}
      />
    </label>
  );
}

/** Popup to edit command re-run interval, kill-timeout, and force an immediate run. */
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
  useDismiss(onClose, anchorRef);

  const [ran, setRan] = useState(false);
  const intervalS = Math.round((cfg?.intervalMs ?? INTERVAL_DEFAULT_S * 1000) / 1000);
  const timeoutS = Math.round((cfg?.timeoutMs ?? TIMEOUT_DEFAULT_S * 1000) / 1000);

  const handleRunNow = (): void => {
    runExtraKeyNow(wireId);
    setRan(true);
  };

  return (
    <div class="xkey-popover floating-surface">
      <SecondsField
        label="Run every (s)"
        min={INTERVAL_MIN_S}
        max={INTERVAL_MAX_S}
        value={intervalS}
        onCommit={(ms) => postExtraKey(wireId, 'command', cfg?.param, ms, cfg?.timeoutMs)}
      />
      <SecondsField
        label="Timeout (s)"
        min={TIMEOUT_MIN_S}
        max={TIMEOUT_MAX_S}
        value={timeoutS}
        onCommit={(ms) => postExtraKey(wireId, 'command', cfg?.param, cfg?.intervalMs, ms)}
      />
      <button class="ghostbtn xkey-popover-run" type="button" onClick={handleRunNow}>
        {ran ? 'Ran ✓' : 'Run now'}
      </button>
    </div>
  );
}

/** Popup for plugin widget: per-key argument, re-poll interval, live status line. */
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
  useDismiss(onClose, anchorRef);

  const intervalS = Math.round((cfg?.intervalMs ?? PLUGIN_INTERVAL_DEFAULT_S * 1000) / 1000);
  // Local state owns arg field — polling re-renders would clobber a controlled value.
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
    <div class="xkey-popover floating-surface">
      <label class="xkey-popover-field xkey-popover-arg">
        <span>Argument</span>
        <input
          class="input"
          type="text"
          maxLength={PARAM_MAX}
          value={arg}
          placeholder="passed as ctx.param"
          onInput={(e) => setArg((e.target as HTMLInputElement).value)}
          onChange={handleArg}
        />
      </label>
      <SecondsField
        label="Run every (s)"
        min={INTERVAL_MIN_S}
        max={INTERVAL_MAX_S}
        value={intervalS}
        onCommit={(ms) => postExtraKey(wireId, 'plugin', cfg?.param, ms, undefined, cfg?.pluginArg)}
      />
      <div class="xkey-popover-status">
        Status: <span class={`xkey-status xkey-status-${st}`}>{STATUS_LABEL[st]}</span>
      </div>
    </div>
  );
}

export function ConfigButton({
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
