// Display widgets for physical keys outside the emulated CORA grid
// (model.keyMap.extraKeys — 293S 6th column, wire ids 16/17/18). Those keys have no
// switches, so each shows a server-rendered value: clock, date, text, or weather.
import { composeLayout, layoutWidget, type WidgetLine, type WidgetPaint } from './widget-render.js';
import { DEFAULT_TAP_FEEDBACK, type TapFeedback } from './settings-store.js';
import {
  COMMAND_INTERVAL_DEFAULT_MS,
  COMMAND_TIMEOUT_DEFAULT_MS,
  DEFAULT_TOUCH_STRIP_MODE,
  PLUS_TOUCH_WIDTH,
  TOUCH_STRIP_REPAINT_DEFAULT_MS,
  WRAPPABLE_WIDGETS,
  type ExtraKeyConfig,
  type ExtraKeyTextSize,
  type ExtraKeyWrap,
  type TouchStripMode,
  type TouchWindowRegion,
} from './types.js';
import type { DeviceDriver } from './devices/driver.js';
import { splashSpec } from './splash-sender.js';
import { forcePluginRefresh, pluginValueFor, type PluginStatus } from './plugin-host.js';
import {
  DEFAULT_SEAMS,
  commandOutputFor,
  refreshCommand,
  refreshWeather,
  weatherTempFor,
  type SourceSeams,
} from './widget-refresh.js';

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

/** Test seams for the widget sources (clock, command runner) + the dock's live
 *  tap-feedback flags (default DEFAULT_TAP_FEEDBACK). */
export type ExtraKeyWidgetsOptions = Partial<SourceSeams> & { tapFeedback?: () => TapFeedback };

/** How long a tap flash shows the inverted widget before the normal repaint. */
export const FLASH_MS = 150;
/** Cap on the '…' placeholder, so a refresh that never reports can't leave it up. */
const PLACEHOLDER_MAX_MS = 15_000;

/** A command may legitimately run its kill timeout twice (the run + one follow-up). */
function placeholderCapMs(cfg: ExtraKeyConfig): number {
  if (cfg.widget !== 'command') return PLACEHOLDER_MAX_MS;
  return 2 * (cfg.timeoutMs ?? COMMAND_TIMEOUT_DEFAULT_MS) + 1000;
}

const PLACEHOLDER_LINES: WidgetLine[] = [{ text: '…', big: true }];
const NO_FEEDBACK: TapFeedback = { flash: false, placeholder: false };

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Lay a free-text blob (custom text / command stdout) onto ≤4 centered lines:
 *  blank → null (clear); a single short line uses the big font. */
function textLines(s: string): WidgetLine[] | null {
  const lines = s
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  const big = lines.length === 1 && lines[0]!.length <= 5;
  return lines.slice(0, 4).map((text) => ({ text, big }));
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

// Per-dock scheduler

/** A zone is DeckBridge's only when a real widget is assigned ('none' = unowned). */
function owns(cfg: ExtraKeyConfig | undefined): cfg is ExtraKeyConfig {
  return cfg !== undefined && cfg.widget !== 'none';
}

function sameIds(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** Ticks once a second, re-renders every configured widget, and repaints a key only
 *  when its content changed (clock → one repaint per minute; idle cost is a few string
 *  compares). One instance per connected dock. */
export class ExtraKeyWidgets {
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastPainted = new Map<number, string>();
  /** Last touch-strip ownership mask pushed to the driver (see pushMask). */
  private lastMask: readonly number[] = [];
  /** Between start() and stop() — a dock that started with nothing to paint ('elgato'
   *  strip, no side keys) must still begin ticking when an override mode is chosen. */
  private active = false;
  /** 'deckbridge-repaint': when the Elgato app last drew on each strip zone. */
  private lastElgatoFrameAt = new Map<number, number>();
  /** 'deckbridge-repaint': strip zones currently showing a widget — the ones that
   *  need the app's image put back when the widget leaves (nothing is masked). */
  private widgetOnZone = new Set<number>();
  private readonly seams: SourceSeams;
  private readonly tapFeedback: () => TapFeedback;
  /** Placeholder feedback: wire ids showing '…' until their tap refresh settles. */
  private refreshing = new Map<number, ReturnType<typeof setTimeout>>();
  /** What each key shows now — the lines a tap flash paints inverted. */
  private shown = new Map<
    number,
    { lines: WidgetLine[]; textSize: ExtraKeyTextSize; wrap?: ExtraKeyWrap }
  >();
  private flashTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly driver: DeviceDriver,
    private readonly configFor: (wireId: number) => ExtraKeyConfig | undefined,
    private mode: TouchStripMode = DEFAULT_TOUCH_STRIP_MODE,
    /** 'deckbridge-repaint' hold-off after an Elgato frame; read live, so a WebUI
     *  change applies without a restart. */
    private readonly repaintIntervalMs: () => number = () => TOUCH_STRIP_REPAINT_DEFAULT_MS,
    /** WebUI mirror of each widget paint (null = cleared), side keys and strip zones. */
    private readonly onWidgetPaint?: (wireId: number, paint: WidgetPaint | null) => void,
    options: ExtraKeyWidgetsOptions = {},
  ) {
    this.seams = { now: options.now ?? DEFAULT_SEAMS.now, run: options.run ?? DEFAULT_SEAMS.run };
    this.tapFeedback = options.tapFeedback ?? (() => DEFAULT_TAP_FEEDBACK);
  }

  start(): void {
    this.active = true;
    // Unconditional: the worker drops its mask on every (re)open.
    this.pushMask(true);
    this.ensureTicking();
  }

  stop(): void {
    this.active = false;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    for (const t of [...this.flashTimers, ...this.refreshing.values()]) clearTimeout(t);
    this.flashTimers.clear();
    this.refreshing.clear();
  }

  private ensureTicking(): void {
    if (!this.active || this.widgetIds().length === 0 || this.timer !== undefined) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), 1000);
  }

  /** Force a full repaint on the next tick (config change / device reinit). */
  repaint(): void {
    this.lastPainted.clear();
    this.pushMask();
    if (this.timer !== undefined) this.tick();
  }

  /** Switch who drives the touch strip (widgetDisplays); side keys are unaffected.
   *  No clearKey on leaving an override: the worker restores the last Elgato image
   *  for every zone that leaves the mask. */
  setTouchStripMode(mode: TouchStripMode): void {
    if (this.mode === mode) return;
    // Leaving to 'elgato' changes no mask, so the worker restores nothing by itself.
    if (mode === 'elgato') this.restoreZones([...this.widgetOnZone]);
    this.widgetOnZone.clear();
    this.mode = mode;
    this.repaint();
    this.ensureTicking();
  }

  /** Build the render context for one widget, kicking off the background
   *  weather/command refresh (which repaints on completion) as a side effect. */
  private contextFor(cfg: ExtraKeyConfig, now: Date): WidgetContext {
    const onUpdate = (): void => this.repaint();
    if (cfg.widget === 'weather') {
      return { now, weatherTemp: weatherTempFor(cfg.param, onUpdate, this.seams.now) };
    }
    if (cfg.widget === 'command') {
      const intervalMs = cfg.intervalMs ?? COMMAND_INTERVAL_DEFAULT_MS;
      const timeoutMs = cfg.timeoutMs ?? COMMAND_TIMEOUT_DEFAULT_MS;
      const out = commandOutputFor(cfg.param, intervalMs, timeoutMs, onUpdate, this.seams);
      return { now, commandOut: out };
    }
    if (cfg.widget === 'plugin') {
      // SECURITY: a plugin is arbitrary user JS (fs/spawn/ffi, same trust as the
      // command widget above) run in an isolated Worker so it can't stall the
      // CORA loop — see plugin-host.ts / plugin-worker.ts. Opt-in per key,
      // trusted-LAN only. `param` = plugin file name, `pluginArg` = ctx.param.
      const { value, status } = pluginValueFor(cfg.param, cfg.pluginArg, cfg.intervalMs, onUpdate);
      return { now, pluginValue: value, pluginStatus: status };
    }
    return { now };
  }

  /** Force an immediate re-run of wireId's command widget (popup "Run now"),
   *  repainting once it completes; mid-run it queues one follow-up. No-op for a
   *  non-command/unconfigured key. */
  forceRun(wireId: number): void {
    const cfg = this.configFor(wireId);
    if (cfg?.widget === 'command') this.startRefresh(cfg, undefined);
  }

  /** Tap refresh (side-key press, strip tap, knob press): rerun/refetch what the
   *  widget shows, or just repaint it. False = no widget on `wireId` right now — the
   *  caller forwards the input as before. */
  refresh(wireId: number): boolean {
    const cfg = this.configFor(wireId);
    if (!owns(cfg) || !this.widgetIds().includes(wireId)) return false;
    // A zone in its Elgato hold-off shows the app's image: refresh, but draw nothing.
    const visible = !this.widgetDisplay(wireId) || this.ownsZoneNow(wireId);
    const { flash, placeholder } = visible ? this.tapFeedback() : NO_FEEDBACK;
    if (flash) this.flash(wireId);
    const onSettled = placeholder ? (): void => this.endPlaceholder(wireId) : undefined;
    const busy = this.startRefresh(cfg, onSettled);
    if (busy && placeholder && !this.refreshing.has(wireId)) {
      const timeout = setTimeout(() => this.endPlaceholder(wireId), placeholderCapMs(cfg));
      this.refreshing.set(wireId, timeout);
    }
    // The flash's own repaint covers the rest; a busy refresh repaints on completion.
    if (!flash && (!busy || placeholder)) this.repaint();
    return true;
  }

  /** The strip zone shows its widget right now — not 'elgato', assigned, and not in a
   *  'deckbridge-repaint' Elgato hold-off — so a tap there is DeckBridge's. */
  ownsZoneNow(wireId: number): boolean {
    if (this.mode === 'elgato' || !this.widgetDisplay(wireId)) return false;
    if (!owns(this.configFor(wireId))) return false;
    return this.mode !== 'deckbridge-repaint' || !this.inElgatoHoldOff(wireId, this.seams.now());
  }

  /** Paint what the key shows with its colours swapped (not recorded in lastPainted,
   *  not mirrored to the WebUI), then repaint it normally after FLASH_MS. */
  private flash(wireId: number): void {
    if (!this.driver.sendSplashImage) return;
    const spec = this.widgetDisplay(wireId)?.image ?? splashSpec(this.driver.model);
    const { lines, textSize, wrap } = this.shown.get(wireId) ?? { lines: [], textSize: 0 };
    const layout = layoutWidget(lines, spec.width, spec.height, textSize, wrap);
    this.driver.sendSplashImage(wireId, composeLayout(layout, spec.width, spec.height, true), spec);
    const timer = setTimeout(() => {
      this.flashTimers.delete(timer);
      this.repaint();
    }, FLASH_MS);
    this.flashTimers.add(timer);
  }

  private endPlaceholder(wireId: number): void {
    const timeout = this.refreshing.get(wireId);
    if (timeout === undefined) return;
    clearTimeout(timeout);
    this.refreshing.delete(wireId);
    this.repaint();
  }

  /** Kick off the widget's forced background refresh (repaints via onUpdate). True =
   *  one is running and `onSettled` fires at its end; false = repaint-only widget. */
  private startRefresh(cfg: ExtraKeyConfig, onSettled: (() => void) | undefined): boolean {
    const onUpdate = (): void => this.repaint();
    switch (cfg.widget) {
      case 'command': {
        const timeoutMs = cfg.timeoutMs ?? COMMAND_TIMEOUT_DEFAULT_MS;
        return refreshCommand(cfg.param, timeoutMs, onUpdate, onSettled, this.seams);
      }
      case 'weather':
        return refreshWeather(cfg.param, onUpdate, onSettled, this.seams.now);
      case 'plugin':
        return forcePluginRefresh(cfg.param, cfg.pluginArg, onSettled);
      default:
        return false;
    }
  }

  private linesFor(
    wireId: number,
    cfg: ExtraKeyConfig | undefined,
    now: Date,
  ): WidgetLine[] | null {
    // contextFor runs even under the placeholder: it keeps a plugin key requested.
    const rendered = cfg ? renderWidgetLines(cfg, this.contextFor(cfg, now)) : null;
    return this.refreshing.has(wireId) ? PLACEHOLDER_LINES : rendered;
  }

  private tick(): void {
    // Before painting, so an Elgato strip frame can't land on a newly owned zone.
    this.pushMask();
    const widgetIds = this.widgetIds();
    if (widgetIds.length === 0) return;
    const now = new Date(this.seams.now());
    for (const wireId of widgetIds) {
      const cfg = this.configFor(wireId);
      if (this.leftToApp(wireId, cfg, now.getTime())) continue;
      const lines = this.linesFor(wireId, cfg, now);
      const textSize = cfg?.textSize ?? 0;
      const wrap = cfg && WRAPPABLE_WIDGETS.includes(cfg.widget) ? cfg.wrap : undefined;
      const sig = lines === null ? '' : JSON.stringify([textSize, wrap, lines]);
      if (this.lastPainted.get(wireId) === sig) continue;
      this.lastPainted.set(wireId, sig);
      this.paint(wireId, lines, textSize, wrap);
    }
  }

  /** 'deckbridge-repaint' zones the widget must not paint this tick: unassigned ones
   *  (the app shows through) and ones inside an Elgato-frame hold-off. */
  private leftToApp(wireId: number, cfg: ExtraKeyConfig | undefined, nowMs: number): boolean {
    if (this.mode !== 'deckbridge-repaint' || !this.widgetDisplay(wireId)) return false;
    if (owns(cfg)) return this.inElgatoHoldOff(wireId, nowMs);
    // Forget the paint so a re-assign repaints.
    this.lastPainted.delete(wireId);
    if (this.widgetOnZone.has(wireId)) this.restoreZones([wireId]);
    return true;
  }

  private paint(
    wireId: number,
    lines: WidgetLine[] | null,
    textSize: ExtraKeyTextSize,
    wrap: ExtraKeyWrap | undefined,
  ): void {
    const display = this.widgetDisplay(wireId);
    if (lines === null) {
      this.shown.delete(wireId);
      this.driver.clearKey(wireId);
      this.onWidgetPaint?.(wireId, null);
      return;
    }
    if (!this.driver.sendSplashImage) return;
    this.shown.set(wireId, { lines, textSize, wrap });
    const spec = display?.image ?? splashSpec(this.driver.model);
    const { width, height } = spec;
    const layout = layoutWidget(lines, width, height, textSize, wrap);
    const bmp = composeLayout(layout, width, height);
    this.driver.sendSplashImage(wireId, bmp, spec);
    const zone = display !== undefined;
    const clipped = layout.clipped;
    this.onWidgetPaint?.(wireId, { bmp, lines, width, height, clipped, wrap, zone });
    if (this.mode === 'deckbridge-repaint' && display) this.widgetOnZone.add(wireId);
  }

  /** An Elgato strip frame reached the device (nothing is masked under
   *  'deckbridge-repaint'): the zones it covers show the app's image until the
   *  repaint interval passes with no further frame, then the widget comes back. */
  noteTouchFrame(region?: TouchWindowRegion): void {
    const ids = this.widgetDisplayIds();
    if (this.mode !== 'deckbridge-repaint' || ids.length === 0) return;
    const sliceWidth = Math.floor(PLUS_TOUCH_WIDTH / ids.length);
    const wholeStrip =
      this.driver.touchStripOptions?.upload === 'always' && this.driver.model.touchStripDisplay;
    const x = wholeStrip ? 0 : (region?.x ?? 0);
    const w = wholeStrip ? PLUS_TOUCH_WIDTH : (region?.w ?? PLUS_TOUCH_WIDTH);
    const nowMs = this.seams.now();
    ids.forEach((wireId, i) => {
      if (x >= (i + 1) * sliceWidth || x + w <= i * sliceWidth) return;
      this.lastElgatoFrameAt.set(wireId, nowMs);
      this.lastPainted.delete(wireId);
      this.widgetOnZone.delete(wireId);
    });
  }

  private restoreZones(wireIds: number[]): void {
    for (const wireId of wireIds) this.widgetOnZone.delete(wireId);
    if (this.active && wireIds.length > 0) this.driver.restoreTouchSegments?.(wireIds);
  }

  private inElgatoHoldOff(wireId: number, nowMs: number): boolean {
    const at = this.lastElgatoFrameAt.get(wireId);
    if (at === undefined) return false;
    if (nowMs - at < this.repaintIntervalMs()) return true;
    this.lastElgatoFrameAt.delete(wireId);
    return false;
  }

  private widgetIds(): readonly number[] {
    const sideKeys = this.driver.model.keyMap.extraKeys ?? [];
    if (this.mode === 'elgato') return sideKeys;
    return [...sideKeys, ...this.widgetDisplayIds()];
  }

  /** Strip zones whose Elgato images the worker must withhold: all of them under
   *  'deckbridge-ignore', none otherwise — under 'deckbridge-repaint' the app's frames
   *  always show, and the widget returns after a hold-off (noteTouchFrame). */
  private stripMask(): readonly number[] {
    return this.mode === 'deckbridge-ignore' ? this.widgetDisplayIds() : [];
  }

  /** Push the ownership mask when it changed (`force`: the worker lost it on open). */
  private pushMask(force = false): void {
    if (!this.active || this.widgetDisplayIds().length === 0) return;
    const mask = this.stripMask();
    if (!force && sameIds(mask, this.lastMask)) return;
    this.lastMask = mask;
    this.driver.setTouchStripMask?.(mask);
  }

  private widgetDisplayIds(): readonly number[] {
    return this.driver.model.widgetDisplays?.map((display) => display.wireId) ?? [];
  }

  private widgetDisplay(wireId: number) {
    return this.driver.model.widgetDisplays?.find((display) => display.wireId === wireId);
  }
}
