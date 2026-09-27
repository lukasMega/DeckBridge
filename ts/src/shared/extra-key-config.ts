// Extra-key widget config (settings.json `extraKeys`, keyed by wire id): the
// persisted shape, its bounds, and the load/import guard.
import type {
  ExtraKeyAlign,
  ExtraKeyFont,
  ExtraKeyPressAction,
  ExtraKeyTextSize,
  ExtraKeyTextStyle,
  ExtraKeyVAlign,
  ExtraKeyWidget,
  ExtraKeyWrap,
} from '../web/contract.js';

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

export const EXTRA_KEY_FONTS = ['regular', 'narrow'] as const satisfies readonly ExtraKeyFont[];
export const EXTRA_KEY_ALIGNS = [
  'left',
  'center',
  'right',
] as const satisfies readonly ExtraKeyAlign[];
export const EXTRA_KEY_VALIGNS = [
  'top',
  'middle',
  'bottom',
] as const satisfies readonly ExtraKeyVAlign[];
export const TEXT_PADDING_MAX = 16;
export const TEXT_LINE_GAP_MAX = 8;
/** Key panel colours — match the WebUI's former canvas icons. */
export const DEFAULT_TEXT_COLOR = '#e8e8ec';
export const DEFAULT_TEXT_BACKGROUND = '#101014';

export const EXTRA_KEY_PRESS_ACTIONS = [
  'refresh',
  'command',
  'both',
] as const satisfies readonly ExtraKeyPressAction[];

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
  /** How the text is drawn (size, wrap, font, colours, …); only non-defaults stored. */
  style?: ExtraKeyTextStyle;
  /** Shell command run on press — only extra keys with a switch
   *  (keyMap.extraKeyInputs). Independent of the widget, so kept across widget changes. */
  pressCommand?: string;
  /** What a press does (pressable keys only) — see effectivePressAction. Part of the
   *  press side like pressCommand, so also kept across widget changes. */
  pressAction?: ExtraKeyPressAction;
}

/** A key's press action, defaulting to today's behaviour: its command when it has
 *  one, else a refresh of its widget. */
export function effectivePressAction(cfg: ExtraKeyConfig | undefined): ExtraKeyPressAction {
  return cfg?.pressAction ?? (cfg?.pressCommand?.trim() ? 'command' : 'refresh');
}

const inRange = (n: number, min: number, max: number): boolean => n >= min && n <= max;

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

type StyleCheck = (v: unknown, field: string) => string | null;

const oneOf =
  (allowed: readonly unknown[]): StyleCheck =>
  (v, field) =>
    allowed.includes(v) ? null : `${field} must be one of: ${allowed.join(', ')}`;
const color: StyleCheck = (v, field) =>
  typeof v === 'string' && HEX_COLOR.test(v) ? null : `${field} must be a #rrggbb colour`;
const intUpTo =
  (max: number): StyleCheck =>
  (v, field) =>
    Number.isInteger(v) && inRange(v as number, 0, max)
      ? null
      : `${field} must be an integer 0..${max}`;
const bool: StyleCheck = (v, field) =>
  typeof v === 'boolean' ? null : `${field} must be true or false`;

const STYLE_CHECKS: Record<keyof ExtraKeyTextStyle, StyleCheck> = {
  textSize: oneOf(EXTRA_KEY_TEXT_SIZES),
  wrap: oneOf(EXTRA_KEY_WRAPS),
  font: oneOf(EXTRA_KEY_FONTS),
  color,
  background: color,
  align: oneOf(EXTRA_KEY_ALIGNS),
  valign: oneOf(EXTRA_KEY_VALIGNS),
  padding: intUpTo(TEXT_PADDING_MAX),
  lineGap: intUpTo(TEXT_LINE_GAP_MAX),
  bold: bool,
  outline: color,
  ellipsis: bool,
};

/** null when `v` is a valid text style; else a message naming the bad field
 *  (`style.padding must be an integer 0..16`). Unknown fields are rejected. */
export function textStyleError(v: unknown, prefix = 'style'): string | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return `${prefix} must be an object`;
  for (const [key, value] of Object.entries(v)) {
    const check = STYLE_CHECKS[key as keyof ExtraKeyTextStyle] as StyleCheck | undefined;
    if (!check) return `${prefix}.${key} is not a text style field`;
    if (value === undefined) continue;
    const err = check(value, `${prefix}.${key}`);
    if (err) return err;
  }
  return null;
}

/** Value of each style field that is never persisted. */
const STYLE_DEFAULTS: Readonly<Record<string, unknown>> = {
  textSize: 0,
  font: 'regular',
  color: DEFAULT_TEXT_COLOR,
  background: DEFAULT_TEXT_BACKGROUND,
  align: 'center',
  valign: 'middle',
  padding: 0,
  lineGap: 0,
  bold: false,
  ellipsis: true,
};

/** A valid style with default and undefined fields dropped and colours lower-cased,
 *  so settings.json stays small and an all-default style is `{}`. */
export function compactTextStyle(style: ExtraKeyTextStyle): ExtraKeyTextStyle {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(style) as Array<[string, unknown]>) {
    // Every string field is a lower-case enum or a colour.
    const value: unknown = typeof raw === 'string' ? raw.toLowerCase() : raw;
    if (value !== undefined && value !== STYLE_DEFAULTS[key]) out[key] = value;
  }
  return out;
}

/** The style a key is drawn with: wrap applies only to free-text widgets. */
export function effectiveTextStyle(cfg: ExtraKeyConfig | undefined): ExtraKeyTextStyle {
  const { wrap, ...rest } = cfg?.style ?? {};
  return cfg && wrap && WRAPPABLE_WIDGETS.includes(cfg.widget) ? { ...rest, wrap } : rest;
}

/** Pre-`style` top-level text fields (unreleased feat/widget-text-size builds). */
interface LegacyTextFields {
  textSize?: ExtraKeyTextSize;
  wrap?: ExtraKeyWrap;
}

/** Fold legacy top-level `textSize`/`wrap` into `style` (an explicit style field wins). */
export function normalizeExtraKeyConfig(cfg: ExtraKeyConfig): ExtraKeyConfig {
  const { textSize, wrap, ...rest } = cfg as ExtraKeyConfig & LegacyTextFields;
  if (textSize === undefined && wrap === undefined) return cfg;
  const style = compactTextStyle({ textSize, wrap, ...cfg.style });
  delete rest.style;
  return Object.keys(style).length > 0 ? { ...rest, style } : rest;
}

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
    (r.style === undefined || textStyleError(r.style) === null) &&
    // Legacy top-level fields — folded into style by normalizeExtraKeyConfig.
    (r.textSize === undefined ||
      (EXTRA_KEY_TEXT_SIZES as readonly unknown[]).includes(r.textSize)) &&
    (r.wrap === undefined || (EXTRA_KEY_WRAPS as readonly unknown[]).includes(r.wrap)) &&
    (r.pressCommand === undefined ||
      (typeof r.pressCommand === 'string' && r.pressCommand.length <= ENCODER_COMMAND_MAX)) &&
    (r.pressAction === undefined ||
      (EXTRA_KEY_PRESS_ACTIONS as readonly unknown[]).includes(r.pressAction))
  );
}
