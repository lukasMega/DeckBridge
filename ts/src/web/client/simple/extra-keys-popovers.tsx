import { useRef, useState } from 'preact/hooks';
import type { ExternalExpire, ExtraKeyCfg, ExtraKeyWidget, PluginStatus } from '../ui-types.js';
import { copyLabel, useCopyText } from '../lib/use-copy-text.js';
import { AnchoredPopover } from '../components/AnchoredPopover.js';
import { GhostButton } from '../components/GhostButton.js';
import { ICON, Icon } from '../components/Icon.js';
import { fire } from '../lib/ui-api.js';
import { getSnapshot, useStore } from '../lib/store.js';
import { scopeIsLive } from './layout-scope.js';
import { SecondsField } from '../components/Fields.js';

// Interval/timeout bounds mirror types.ts, in seconds for UI.
const INTERVAL_MIN_S = 1;
const INTERVAL_MAX_S = 3600;
const INTERVAL_DEFAULT_S = 10;
const TIMEOUT_MIN_S = 1;
const TIMEOUT_MAX_S = 60;
const TIMEOUT_DEFAULT_S = 5;
const PLUGIN_INTERVAL_DEFAULT_S = 5;
export const PARAM_MAX = 128; // mirrors EXTRA_KEY_PARAM_MAX (types.ts)
export const CHANNEL_MAX = 32; // mirrors PUSH_CHANNEL_RE (push-text.ts)

const STATUS_LABEL: Record<PluginStatus, string> = {
  pending: 'pending',
  ok: 'ok',
  err: 'ERR',
  disabled: 'disabled',
};

/** The widget part of a key's config; the press command posts separately. */
export type WidgetCfg = Omit<ExtraKeyCfg, 'pressCommand' | keyof DisplayPrefs>;
/** How the widget text is drawn — kept across widget changes. */
export type DisplayPrefs = Pick<ExtraKeyCfg, 'style'>;

/** The server replaces the whole widget part, so every post carries the display prefs too. */
export function postExtraKey(wireId: number, next: WidgetCfg, prefs: DisplayPrefs = {}): void {
  const { widget, param, intervalMs, timeoutMs, pluginArg, expire, fallbackText } = next;
  const { style } = prefs;
  const { layoutScope } = getSnapshot();
  fire('/api/extra-key', {
    wireId,
    ...(layoutScope !== null ? { pageId: layoutScope } : {}),
    widget,
    ...(param ? { param } : {}),
    ...(intervalMs !== undefined ? { intervalMs } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(pluginArg !== undefined ? { pluginArg } : {}),
    ...(expire !== undefined ? { expire } : {}),
    ...(fallbackText ? { fallbackText } : {}),
    ...(style && Object.keys(style).length > 0 ? { style } : {}),
  });
}

/** A press-side post (action / command); edits the scoped page's layout like postExtraKey. */
export function postExtraKeyPress(body: {
  wireId: number;
  action?: string;
  command?: string;
}): void {
  const { layoutScope } = getSnapshot();
  fire('/api/extra-key/press', {
    ...body,
    ...(layoutScope !== null ? { pageId: layoutScope } : {}),
  });
}

function runExtraKeyNow(wireId: number): void {
  fire('/api/extra-key/run', { wireId });
}

export function paramPlaceholder(widget: ExtraKeyWidget): string {
  if (widget === 'weather') return 'lat,lon e.g. 50.08,14.43';
  if (widget === 'command') return 'shell command e.g. date +%H:%M';
  if (widget === 'external') return 'channel e.g. obs-rec';
  return 'text (\\n = new line)';
}

/** Popup body to edit command re-run interval, kill-timeout, and force an immediate run. */
function CommandConfig({
  wireId,
  cfg,
}: Readonly<{ wireId: number; cfg?: ExtraKeyCfg }>): preact.JSX.Element {
  const [ran, setRan] = useState(false);
  // Run now acts on the key as painted on the deck: only the live layout has one.
  const live = useStore((s) => scopeIsLive(s));
  const intervalS = Math.round((cfg?.intervalMs ?? INTERVAL_DEFAULT_S * 1000) / 1000);
  const timeoutS = Math.round((cfg?.timeoutMs ?? TIMEOUT_DEFAULT_S * 1000) / 1000);

  const handleRunNow = (): void => {
    runExtraKeyNow(wireId);
    setRan(true);
  };
  const post = (patch: Partial<WidgetCfg>): void =>
    postExtraKey(
      wireId,
      {
        widget: 'command',
        param: cfg?.param,
        intervalMs: cfg?.intervalMs,
        timeoutMs: cfg?.timeoutMs,
        ...patch,
      },
      cfg,
    );

  return (
    <>
      <SecondsField
        label="Run every (s)"
        min={INTERVAL_MIN_S}
        max={INTERVAL_MAX_S}
        value={intervalS}
        onCommit={(intervalMs) => post({ intervalMs })}
      />
      <SecondsField
        label="Timeout (s)"
        min={TIMEOUT_MIN_S}
        max={TIMEOUT_MAX_S}
        value={timeoutS}
        onCommit={(timeoutMs) => post({ timeoutMs })}
      />
      <GhostButton
        class="xkey-popover-run"
        disabled={!live}
        title={live ? undefined : 'This layout is not on the deck right now'}
        onClick={handleRunNow}
      >
        {ran ? 'Ran ✓' : 'Run now'}
      </GhostButton>
    </>
  );
}

/** Popup body for plugin widget: per-key argument, re-poll interval, live status line. */
function PluginConfig({
  wireId,
  cfg,
  status,
}: Readonly<{ wireId: number; cfg?: ExtraKeyCfg; status?: PluginStatus }>): preact.JSX.Element {
  const intervalS = Math.round((cfg?.intervalMs ?? PLUGIN_INTERVAL_DEFAULT_S * 1000) / 1000);
  // Local state owns arg field — polling re-renders would clobber a controlled value.
  const [arg, setArg] = useState(cfg?.pluginArg ?? '');
  const post = (patch: Partial<WidgetCfg>): void =>
    postExtraKey(
      wireId,
      {
        widget: 'plugin',
        param: cfg?.param,
        intervalMs: cfg?.intervalMs,
        pluginArg: cfg?.pluginArg,
        ...patch,
      },
      cfg,
    );
  const st = status ?? 'pending';

  return (
    <>
      <label class="xkey-popover-field xkey-popover-arg">
        <span>Argument</span>
        <input
          class="input"
          type="text"
          maxLength={PARAM_MAX}
          value={arg}
          placeholder="passed as ctx.param"
          onInput={(e) => setArg((e.target as HTMLInputElement).value)}
          onChange={(e) => post({ pluginArg: (e.target as HTMLInputElement).value })}
        />
      </label>
      <SecondsField
        label="Run every (s)"
        min={INTERVAL_MIN_S}
        max={INTERVAL_MAX_S}
        value={intervalS}
        onCommit={(intervalMs) => post({ intervalMs })}
      />
      <div class="xkey-popover-status">
        Status: <span class={`xkey-status xkey-status-${st}`}>{STATUS_LABEL[st]}</span>
      </div>
    </>
  );
}

const EXPIRE_OPTIONS: ReadonlyArray<{ value: ExternalExpire; label: string }> = [
  { value: 'dim', label: 'Dim last value' },
  { value: 'blank', label: 'Blank' },
  { value: 'text', label: 'Show text' },
];

/** Popup body for the push (external) widget: what an expired value shows, plus a ready curl line. */
function ExternalConfig({
  wireId,
  cfg,
}: Readonly<{ wireId: number; cfg?: ExtraKeyCfg }>): preact.JSX.Element {
  const copy = useCopyText();
  const expire = cfg?.expire ?? 'dim';
  const [fallback, setFallback] = useState(cfg?.fallbackText ?? '');
  const post = (next: { expire?: ExternalExpire; fallbackText?: string }): void =>
    postExtraKey(
      wireId,
      { widget: 'external', param: cfg?.param, expire: expire, fallbackText: fallback, ...next },
      cfg,
    );
  const curl =
    `curl -X POST ${location.origin}/api/push/${cfg?.param ?? 'channel'} ` +
    `-H "Authorization: Bearer $DECKBRIDGE_PUSH_TOKEN" -H "Content-Type: application/json" ` +
    `-d '{"text":"hello","ttl":60}'`;

  return (
    <>
      <label class="xkey-popover-field">
        <span>When the value expires</span>
        <select
          class="input"
          value={expire}
          onChange={(e) =>
            post({ expire: (e.target as HTMLSelectElement).value as ExternalExpire })
          }
        >
          {EXPIRE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      {expire === 'text' && (
        <label class="xkey-popover-field xkey-popover-arg">
          <span>Text</span>
          <input
            class="input"
            type="text"
            maxLength={PARAM_MAX}
            value={fallback}
            placeholder="--"
            onInput={(e) => setFallback((e.target as HTMLInputElement).value)}
            onChange={(e) => post({ fallbackText: (e.target as HTMLInputElement).value })}
          />
        </label>
      )}
      <code class="xkey-popover-curl">{curl}</code>
      <GhostButton class="xkey-popover-run" onClick={() => copy.copy(curl)}>
        {copyLabel(copy.status, 'Copy curl')}
      </GhostButton>
    </>
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
  let body: preact.JSX.Element | null = null;
  if (widget === 'command') body = <CommandConfig wireId={wireId} cfg={cfg} />;
  else if (widget === 'plugin')
    body = <PluginConfig wireId={wireId} cfg={cfg} status={pluginStatus} />;
  else if (widget === 'external') body = <ExternalConfig wireId={wireId} cfg={cfg} />;
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
      {showConfig && body && (
        <AnchoredPopover
          anchorRef={anchorRef}
          onClose={() => setShowConfig(false)}
          label={`${label} ${widget} settings`}
        >
          {body}
        </AnchoredPopover>
      )}
    </div>
  );
}
