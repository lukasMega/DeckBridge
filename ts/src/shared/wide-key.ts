// Per-device info-window ("wide key") settings: defaults, validation, firmware-mode
// mapping. Pure; used by the settings loader, the WebUI route and main/dock-wide-key.ts.
import type { DeviceModel } from '../devices/driver.js';
import type {
  ResolvedWideKey,
  WideKeyClockMode,
  WideKeyConfig,
  WideKeyContent,
  WideKeyElgatoSource,
  WideKeyPress,
} from '../web/contract-wide-key.js';
import { isTouchStripRepaintMs, TOUCH_STRIP_REPAINT_DEFAULT_MS } from './types.js';

export const WIDE_KEY_CONTENTS: readonly WideKeyContent[] = [
  'clock',
  'dial',
  'stats',
  'widget',
  'elgato',
];
export const WIDE_KEY_CLOCK_MODES: readonly WideKeyClockMode[] = [200, 201, 202, 203];
export const WIDE_KEY_HOUR_FORMATS = ['12H', '24H'] as const;
export const WIDE_KEY_PRESSES = ['elgato-13', 'elgato-14', 'deckbridge', 'none'] as const;
export const WIDE_KEY_STATS_PLUGIN_MAX = 256;
export const WIDE_KEY_ELGATO_SOURCES = ['both', 'elgato-13', 'elgato-14'] as const;
export const WIDE_KEY_ELGATO_IMAGES = ['ignore', 'override'] as const;

/** MK.2 cells under the window, left to right: what each source composes. */
const SOURCE_CELLS: Readonly<Record<WideKeyElgatoSource, readonly number[]>> = {
  both: [13, 14],
  'elgato-13': [13],
  'elgato-14': [14],
};

/** The widget content (mode 2) and the DeckBridge press action are wired: the slot-13 image
 *  path and the wire-13 widget editor exist. Kept as a switch so a firmware that cannot show
 *  a mode-2 background can turn both off in one place. */
export const WIDE_KEY_WIDGET_READY = true;

/** Firmware small-window mode that shows a host image (the `widget` content). */
export const WIDE_KEY_IMAGE_MODE = 2;

/** Firmware small-window modes of the fixed (non-clock) contents. */
const FIXED_MODE: Readonly<Record<Exclude<WideKeyContent, 'clock'>, number>> = {
  stats: 0,
  dial: 1,
  widget: WIDE_KEY_IMAGE_MODE,
  elgato: WIDE_KEY_IMAGE_MODE,
};

/** No entry = what DeckBridge always showed: the digital clock, time only. */
export const DEFAULT_WIDE_KEY: Readonly<ResolvedWideKey> = {
  content: 'clock',
  clockMode: 203,
  hourFormat: '24H',
  press: 'none',
  elgatoSource: 'both',
  elgatoImages: 'ignore',
  overrideMs: TOUCH_STRIP_REPAINT_DEFAULT_MS,
};

type Check = (v: unknown) => string | null;

const oneOf =
  (allowed: readonly unknown[]): Check =>
  (v) =>
    allowed.includes(v) ? null : `must be one of: ${allowed.join(', ')}`;
const pluginName: Check = (v) =>
  typeof v === 'string' && v.length > 0 && v.length <= WIDE_KEY_STATS_PLUGIN_MAX
    ? null
    : `must be a non-empty string of at most ${WIDE_KEY_STATS_PLUGIN_MAX} characters`;

const CHECKS: ReadonlyArray<readonly [keyof WideKeyConfig, Check]> = [
  ['content', oneOf(WIDE_KEY_CONTENTS)],
  ['clockMode', oneOf(WIDE_KEY_CLOCK_MODES)],
  ['hourFormat', oneOf(WIDE_KEY_HOUR_FORMATS)],
  ['press', oneOf(WIDE_KEY_PRESSES)],
  ['statsPlugin', pluginName],
  ['elgatoSource', oneOf(WIDE_KEY_ELGATO_SOURCES)],
  ['elgatoImages', oneOf(WIDE_KEY_ELGATO_IMAGES)],
  ['overrideMs', (v) => (isTouchStripRepaintMs(v) ? null : 'must be an integer 1000-3600000')],
];

/** Persisted partial → full config over DEFAULT_WIDE_KEY. */
export function resolveWideKey(partial: Partial<WideKeyConfig> | undefined): ResolvedWideKey {
  return { ...DEFAULT_WIDE_KEY, ...pickWideKeyKeys({ ...partial }) };
}

/** The window can show `content` now: an image content needs the wired image path. */
function contentReady(content: WideKeyContent): boolean {
  return (content !== 'widget' && content !== 'elgato') || WIDE_KEY_WIDGET_READY;
}

/** The contents and clock variants a model offers, from its small-window mode list. */
export function wideKeyChoices(modes: readonly number[]): {
  contents: WideKeyContent[];
  clockModes: WideKeyClockMode[];
} {
  const clockModes = WIDE_KEY_CLOCK_MODES.filter((m) => modes.includes(m));
  const contents = WIDE_KEY_CONTENTS.filter((c) => {
    if (c === 'clock') return clockModes.length > 0;
    return modes.includes(FIXED_MODE[c]) && contentReady(c);
  });
  return { contents, clockModes };
}

/** The press routings offered now. A stored 'deckbridge' still routes (it just finds no
 *  widget to act on until the flag flips). */
export function wideKeyPresses(): WideKeyPress[] {
  return WIDE_KEY_PRESSES.filter((p) => p !== 'deckbridge' || WIDE_KEY_WIDGET_READY);
}

/** null = valid. Checks only present keys and ignores unknown ones. With `modes` (the
 *  model's list) it also rejects a content or clock variant the model cannot show. */
export function wideKeyError(v: unknown, modes?: readonly number[]): string | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return 'wideKey must be an object';
  }
  const r = v as Record<string, unknown>;
  for (const [key, check] of CHECKS) {
    const err = r[key] === undefined ? null : check(r[key]);
    if (err) return `${key} ${err}`;
  }
  if (!modes) return null;
  const cfg = resolveWideKey(pickWideKeyKeys(r));
  const { contents, clockModes } = wideKeyChoices(modes);
  if (!contents.includes(cfg.content)) return `content '${cfg.content}' is not available`;
  if (r.clockMode !== undefined && !clockModes.includes(cfg.clockMode)) {
    return `clockMode ${cfg.clockMode} is not available`;
  }
  if (!wideKeyPresses().includes(cfg.press)) return `press '${cfg.press}' is not available`;
  return null;
}

/** Keep only known keys (what the POST handler persists). */
export function pickWideKeyKeys(v: Record<string, unknown>): Partial<WideKeyConfig> {
  const out: Record<string, unknown> = {};
  for (const [key] of CHECKS) if (v[key] !== undefined) out[key] = v[key];
  return out;
}

/** Device wire id of a model's info window — the manifest slot of `page.smallWindowSlot`
 *  (D200: 13) — or undefined for a model without one. It is both the window's image id and
 *  the input code of its press. */
export function wideKeyWire(model: DeviceModel): number | undefined {
  const slot = model.page?.smallWindowSlot;
  return slot && slot.row * model.columns + slot.col;
}

/** `DeviceType`s that share the D200's VID:PID but turn slot 13 into a real key (D8 of the
 *  parent plan, Q5): there is no info window to configure on them. */
const NO_WINDOW_TYPES: readonly string[] = ['D200X'];

/** The model has an info window and this unit really has one (a D200X reports otherwise). */
export function hasWideWindow(model: DeviceModel, deviceType?: string): boolean {
  if (wideKeyWire(model) === undefined) return false;
  return !NO_WINDOW_TYPES.includes((deviceType ?? '').toUpperCase());
}

/** `keyMap.extraKeys` without the info window: the window is configured by its own card, so
 *  the side-key panels, the verify wizard and the page editor never see it (D8). */
export function sideExtraKeys(model: DeviceModel): readonly number[] {
  const wire = wideKeyWire(model);
  return (model.keyMap.extraKeys ?? []).filter((id) => id !== wire);
}

/** The firmware small-window mode to show; the model default when the content cannot be
 *  shown (not listed, or the widget before it is wired). */
export function wideKeyFirmwareMode(
  cfg: ResolvedWideKey,
  page: { smallWindowMode: number; smallWindowModes: readonly number[] },
): number {
  const mode = cfg.content === 'clock' ? cfg.clockMode : FIXED_MODE[cfg.content];
  return contentReady(cfg.content) && page.smallWindowModes.includes(mode)
    ? mode
    : page.smallWindowMode;
}

/** The window is in the firmware stats mode, the one that reads host CPU / memory / GPU. */
export function wideKeyShowsStats(
  cfg: ResolvedWideKey,
  page: { smallWindowMode: number; smallWindowModes: readonly number[] },
): boolean {
  return wideKeyFirmwareMode(cfg, page) === FIXED_MODE.stats;
}

/** What the worker composes into the window and whether Elgato images may reach it. */
export interface WideWindowElgato {
  /** MK.2 cells, left to right; [] = the window never shows Elgato images. */
  cells: readonly number[];
  /** False while a widget owns the window ('ignore'): frames are kept, not drawn. */
  show: boolean;
}

/** The Elgato side of a resolved config: content 'elgato' always shows the cells, a widget
 *  shows them only under 'override'. */
export function wideWindowElgato(cfg: ResolvedWideKey): WideWindowElgato {
  if (cfg.content !== 'elgato' && cfg.content !== 'widget') return { cells: [], show: false };
  return {
    cells: SOURCE_CELLS[cfg.elgatoSource],
    show: cfg.content === 'elgato' || cfg.elgatoImages === 'override',
  };
}
