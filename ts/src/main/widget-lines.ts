// What a widget key shows right now, as text lines — pure, so the per-dock
// scheduler (extra-keys.ts) and its tests share one source of truth.
import type { WidgetLine } from '../shared/widget-layout.js';
import type { ExtraKeyConfig } from '../shared/types.js';
import type { PluginStatus } from '../plugin/plugin-host.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');

/** Everything time/network-dependent a widget can show, injected for testability. */
export interface WidgetContext {
  now: Date;
  /** Last known temperature (°C) for the widget's location; undefined = not fetched yet. */
  weatherTemp?: number;
  /** Last stdout of the command widget's command; undefined = not run yet. */
  commandOut?: string;
  /** plugin widget: last value from the plugin host; undefined = not fetched
   *  yet, null = the plugin returned null (clear the key). */
  pluginValue?: string | null;
  /** plugin widget: the key's plugin run status (ERR/disabled → 'ERR' on the key). */
  pluginStatus?: PluginStatus;
}

const MAX_TEXT_LINES = 4;
const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Lay a free-text blob (custom text / command stdout) onto ≤4 centered lines:
 *  blank → null (clear); a single short line uses the big font. */
function textLines(s: string): WidgetLine[] | null {
  // Walk lazily: command stdout can be large and this runs every tick.
  const lines: string[] = [];
  for (let start = 0; start <= s.length && lines.length < MAX_TEXT_LINES;) {
    const nl = s.indexOf('\n', start);
    const end = nl === -1 ? s.length : nl;
    const line = s.slice(start, end).trim();
    if (line.length > 0) lines.push(line);
    start = end + 1;
  }
  if (lines.length === 0) return null;
  const big = lines.length === 1 && lines[0]!.length <= 5;
  return lines.map((text) => ({ text, big }));
}

/** The lines a widget shows right now, or null to clear the key ('none'). */
// oxlint-disable-next-line complexity
export function renderWidgetLines(cfg: ExtraKeyConfig, ctx: WidgetContext): WidgetLine[] | null {
  switch (cfg.widget) {
    case 'clock':
      return [{ text: `${pad2(ctx.now.getHours())}:${pad2(ctx.now.getMinutes())}`, big: true }];
    case 'date':
      return [
        { text: WEEKDAYS[ctx.now.getDay()]!, big: false },
        { text: String(ctx.now.getDate()), big: true },
        { text: MONTHS[ctx.now.getMonth()]!, big: false },
      ];
    case 'text':
      return textLines(cfg.param ?? '');
    case 'weather': {
      const t = ctx.weatherTemp;
      return [{ text: t === undefined ? '--' : `${Math.round(t)}\xb0`, big: true }];
    }
    case 'command':
      // Not run yet → a single dot placeholder; empty stdout → clear.
      return ctx.commandOut === undefined ? [{ text: '…', big: true }] : textLines(ctx.commandOut);
    case 'plugin':
      // ERR/disabled → 'ERR'; no value yet → '…' placeholder (like command);
      // null return → clear; a value → centered text lines.
      if (ctx.pluginStatus === 'err' || ctx.pluginStatus === 'disabled') {
        return [{ text: 'ERR', big: true }];
      }
      if (ctx.pluginValue === undefined) return [{ text: '…', big: true }];
      return ctx.pluginValue === null ? null : textLines(ctx.pluginValue);
    case 'none':
      return null;
  }
}
