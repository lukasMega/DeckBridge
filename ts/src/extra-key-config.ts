// Extra-key widget config (settings.json `extraKeys`, keyed by wire id): the
// persisted shape, its bounds, and the load/import guard.
import type { ExtraKeyTextSize, ExtraKeyWidget, ExtraKeyWrap } from './web/contract.js';

// Extra keys (physical keys outside the emulated CORA grid)
// 293S: the 6th column (wire ids 16/17/18) never maps to an MK.2 index, so
// DeckBridge binds its own actions to it. Config is persisted per device in
// settings.json (DeviceIdentitySettings.extraKeys, keyed by wire id).

// The extra keys are display-only (293S 6th column has no switches — verified
// on hardware 2026-07-16), so each is a small server-rendered widget, not an
// action trigger.
export const EXTRA_KEY_WIDGETS = [
  'none',
  'clock',
  'date',
  'text',
  'weather',
  'command',
  'plugin',
] as const satisfies readonly ExtraKeyWidget[];

/** Every widget text size, in the order the WebUI size picker shows them. */
export const EXTRA_KEY_TEXT_SIZES = [
  'fit',
  -2,
  -1,
  0,
  1,
  2,
] as const satisfies readonly ExtraKeyTextSize[];

export const EXTRA_KEY_WRAPS = ['words', 'chars'] as const satisfies readonly ExtraKeyWrap[];

/** Widgets showing free text — the only ones a wrap setting applies to. */
export const WRAPPABLE_WIDGETS: readonly ExtraKeyWidget[] = ['text', 'command', 'plugin'];

/** Cap on one encoder shell command (EncoderCommands press/rotateCw/rotateCcw) and
 *  on an extra key's press command (ExtraKeyConfig.pressCommand). */
export const ENCODER_COMMAND_MAX = 512;

/** Cap on the widget param (text content / weather "lat,lon" / shell command /
 *  plugin file name) and on the plugin per-key argument (pluginArg). */
export const EXTRA_KEY_PARAM_MAX = 128;

// Plugin widget: user JS run in an isolated Worker (see plugin-host.ts). Poll
// interval reuses ExtraKeyConfig.intervalMs as an override; the worker enforces
// the floor and default. Value strings are capped before rendering.
export const PLUGIN_INTERVAL_DEFAULT_MS = 5 * 1000;
export const PLUGIN_INTERVAL_MIN_MS = 1000;
export const PLUGIN_VALUE_MAX = 256;

// Command widget re-run interval / kill-timeout — user-configurable within
// these bounds (see extra-key-config popup), default when unset.
export const COMMAND_INTERVAL_DEFAULT_MS = 10 * 1000;
export const COMMAND_INTERVAL_MIN_MS = 1000;
export const COMMAND_INTERVAL_MAX_MS = 60 * 60 * 1000;
export const COMMAND_TIMEOUT_DEFAULT_MS = 5 * 1000;
export const COMMAND_TIMEOUT_MIN_MS = 1000;
export const COMMAND_TIMEOUT_MAX_MS = 60 * 1000;

export interface ExtraKeyConfig {
  widget: ExtraKeyWidget;
  /** text: the content to show; weather: "lat,lon"; command: the shell command;
   *  plugin: the plugin file name (in the plugins dir). */
  param?: string;
  /** command/plugin widget: how often (ms) to re-run/poll. Command default
   *  COMMAND_INTERVAL_DEFAULT_MS; plugin default PLUGIN_INTERVAL_DEFAULT_MS. */
  intervalMs?: number;
  /** command widget only: kill the process after this many ms. Default COMMAND_TIMEOUT_DEFAULT_MS. */
  timeoutMs?: number;
  /** plugin widget only: the per-key argument passed to the plugin (ctx.param). */
  pluginArg?: string;
  /** Text size step on the font ladder, or 'fit'. Absent = 0 (never persisted as 0). */
  textSize?: ExtraKeyTextSize;
  /** Line wrapping for free-text widgets (WRAPPABLE_WIDGETS). Absent = off. */
  wrap?: ExtraKeyWrap;
  /** Shell command run on press — only extra keys with a switch
   *  (keyMap.extraKeyInputs). Independent of the widget, so kept across widget changes. */
  pressCommand?: string;
}

const inRange = (n: number, min: number, max: number): boolean => n >= min && n <= max;

/** Shape guard for one persisted/imported extra-key entry. */
// oxlint-disable-next-line complexity
export function isExtraKeyConfig(v: unknown): v is ExtraKeyConfig {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.widget === 'string' &&
    (EXTRA_KEY_WIDGETS as readonly string[]).includes(r.widget) &&
    (r.param === undefined ||
      (typeof r.param === 'string' && r.param.length <= EXTRA_KEY_PARAM_MAX)) &&
    (r.intervalMs === undefined ||
      (typeof r.intervalMs === 'number' &&
        inRange(r.intervalMs, COMMAND_INTERVAL_MIN_MS, COMMAND_INTERVAL_MAX_MS))) &&
    (r.timeoutMs === undefined ||
      (typeof r.timeoutMs === 'number' &&
        inRange(r.timeoutMs, COMMAND_TIMEOUT_MIN_MS, COMMAND_TIMEOUT_MAX_MS))) &&
    (r.pluginArg === undefined ||
      (typeof r.pluginArg === 'string' && r.pluginArg.length <= EXTRA_KEY_PARAM_MAX)) &&
    (r.textSize === undefined ||
      (EXTRA_KEY_TEXT_SIZES as readonly unknown[]).includes(r.textSize)) &&
    (r.wrap === undefined || (EXTRA_KEY_WRAPS as readonly unknown[]).includes(r.wrap)) &&
    (r.pressCommand === undefined ||
      (typeof r.pressCommand === 'string' && r.pressCommand.length <= ENCODER_COMMAND_MAX))
  );
}
