import { useEffect, useRef, useState } from 'preact/hooks';
import type { ExtraKeyCfg, ExtraKeyWidget, PluginStatus } from '../ui-types.js';
import { ICON } from '../ui-icons.js';
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

export function paramPlaceholder(widget: ExtraKeyWidget): string {
  if (widget === 'weather') return 'lat,lon e.g. 50.08,14.43';
  if (widget === 'command') return 'shell command e.g. date +%H:%M';
  return 'text (\\n = new line)';
}

function usePopoverDismiss(
  anchorRef: { current: HTMLDivElement | null },
  onClose: () => void,
): void {
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
  usePopoverDismiss(anchorRef, onClose);

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
          class="input"
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
          class="input"
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
  usePopoverDismiss(anchorRef, onClose);

  const intervalS = Math.round((cfg?.intervalMs ?? PLUGIN_INTERVAL_DEFAULT_S * 1000) / 1000);
  const handleInterval = (e: Event): void => {
    const s = Number((e.target as HTMLInputElement).value);
    if (!Number.isFinite(s) || s < INTERVAL_MIN_S || s > INTERVAL_MAX_S) return;
    postExtraKey(wireId, 'plugin', cfg?.param, Math.round(s * 1000), undefined, cfg?.pluginArg);
  };
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
    <div class="xkey-popover">
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
      <label class="xkey-popover-field">
        <span>Run every (s)</span>
        <input
          class="input"
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
