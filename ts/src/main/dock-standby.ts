// Per-dock standby / burn-in controller: decides the effective backlight from idle,
// night, app-gone and screen-off state, and tells a StandbySink what to do. The
// Dock's brightness stays the *requested* level (it is what gets persisted).
// Design: .claude/plans/2026-09-30_standby-burn-in-care.md
import { DEFAULT_BRIGHTNESS } from '../shared/types.js';
import type {
  ClientApp,
  DialEvent,
  DisplayState,
  KeyState,
  StandbySettings,
} from '../shared/types.js';
import { parseHhmm } from '../shared/standby-settings.js';
import { sendSplashImages } from '../shared/splash-sender.js';
import type { DockDriver } from '../devices/driver.js';
import type { ExtraKeyWidgets } from './extra-keys.js';
import type { ImageFormat, LastFrames } from './dock-frames.js';
import { createStandbyHooks } from './standby-hooks.js';
import { StandbyClockPainter } from './standby-clock.js';
import type { CoraDock } from './cora-dock.js';
import type { DockStatusInput } from './dock-status.js';
import {
  computeDisplay,
  inNightWindow,
  standbyTiming,
  SYSTEM_CLOCK,
  type CapResult,
  type StandbyClock,
  type StandbyTiming,
} from './standby-policy.js';

export type StandbyInput =
  | { kind: 'key'; mk2: number; state: KeyState }
  | { kind: 'extraKey'; wireId: number; state: KeyState }
  | { kind: 'dialPress'; index: number; state: KeyState }
  | { kind: 'dialRotate'; index: number }
  | { kind: 'touch' };

export interface StandbySink {
  /** Write the effective level to the attached driver (only called on change). */
  applyBrightness(level: number): void;
  /** Hardware sleep on/off (only when canSleep() and offMode 'auto'). */
  setSleep(asleep: boolean): void;
  enterStandby(): void;
  exitStandby(): void;
  /** Painter tick: minute changed or brightness came back from 0. */
  paintStandby(nowMs: number): void;
  /** Left `off`: widgets.repaint(); afterSleep → also splash + LastFrames.repaint. */
  wakeRepaint(afterSleep: boolean): void;
  runHook(kind: 'sleep' | 'wake'): void;
  /** Dock.changed() → status broadcast. */
  changed(): void;
}

export interface DockStandbyDeps {
  settings: () => StandbySettings;
  pairedBefore: () => boolean;
  /** Driver attached and driver.model.sleep set. */
  canSleep: () => boolean;
  /** False for the browser deck (driver.paintsSplash === false): 'clock' acts as 'off'. */
  canShowClock: () => boolean;
  link: { childHasClient(): boolean; childRxIdleMs(): number };
  sink: StandbySink;
  clock?: StandbyClock;
  timing?: StandbyTiming;
}

/** A knob event as a standby input. */
export function dialInput(e: DialEvent): StandbyInput {
  return e.kind === 'press'
    ? { kind: 'dialPress', index: e.index, state: e.state }
    : { kind: 'dialRotate', index: e.index };
}

function tagOf(i: StandbyInput): string | undefined {
  switch (i.kind) {
    case 'key':
      return `key:${i.mk2}`;
    case 'extraKey':
      return `extra:${i.wireId}`;
    case 'dialPress':
      return `dial:${i.index}`;
    default:
      return undefined;
  }
}

export class DockStandby {
  private readonly clock: StandbyClock;
  private readonly timing: StandbyTiming;
  private readonly bornAt: number;
  private requested = DEFAULT_BRIGHTNESS;
  private lastInputAt: number;
  private lastTickAt: number;
  private res: CapResult;
  private tickTimer: unknown;
  private debounceTimer: unknown;
  private exitTimer: unknown;
  private wakeTimer: unknown;
  private attached = false;
  private sessionSeen = false;
  /** App absent past the debounce / silent past silenceMs. */
  private detachedGone = false;
  private silent = false;
  private clientApp: ClientApp = 'unknown';
  private off = false;
  private sleeping = false;
  private lastApplied: number | undefined;
  /** Standby wanted, and whether the painter has drawn (it waits out `off`). */
  private inStandby = false;
  private painted = false;
  private lastPaintMinute = -1;
  private readonly swallowed = new Set<string>();
  private muted = false;
  /** The sleep hook ran and no wake hook has yet (a replug must not skip it). */
  private wakePending = false;

  constructor(private readonly deps: DockStandbyDeps) {
    this.clock = deps.clock ?? SYSTEM_CLOCK;
    this.timing = deps.timing ?? standbyTiming();
    this.bornAt = this.lastInputAt = this.lastTickAt = this.clock.now();
    this.res = this.evaluate(this.bornAt);
    this.syncTimers();
  }

  get effective(): number {
    return this.res.effective;
  }
  get state(): DisplayState {
    return this.res.state;
  }
  /** The DockStatus view: state, level on the panel, what the driver can do. */
  get display(): NonNullable<DockStatusInput['display']> {
    const caps = { sleep: this.deps.canSleep(), clock: this.deps.canShowClock() };
    return { state: this.res.state, effectiveBrightness: this.res.effective, caps };
  }

  /** Requested level changed (user/app/resend); applies the effective one. */
  setRequested(level: number): void {
    this.requested = level;
    const r = this.evaluate(this.clock.now());
    // The caller broadcasts the new requested level itself; don't notify twice.
    this.muted = true;
    try {
      // An uncapped explicit set is written through, like before the feature existed.
      this.recompute(r.effective === level && r.state !== 'off');
    } finally {
      this.muted = false;
    }
  }

  /** WebUI slider / click-to-press: counts as activity, never swallowed. */
  noteActivity(): void {
    this.lastInputAt = this.clock.now();
    this.recompute();
  }

  /** Physical/mock input. true = consumed (do not forward). */
  noteInput(input: StandbyInput): boolean {
    const now = this.clock.now();
    const tag = tagOf(input);
    const isUp = 'state' in input && input.state === 'up';
    // A swallowed down whose up was lost would otherwise eat this press's up.
    if (tag !== undefined && 'state' in input && input.state === 'down') this.swallowed.delete(tag);
    if (!this.featuresOn()) {
      this.lastInputAt = now;
      return isUp && tag !== undefined && this.swallowed.delete(tag);
    }
    const before = this.evaluate(now).effective;
    this.lastInputAt = now;
    // An up always follows its down's fate, even if it is what wakes the deck.
    const waking = !isUp && this.evaluate(now).effective > before;
    this.recompute();
    if (isUp) return tag !== undefined && this.swallowed.delete(tag);
    const swallow = waking && this.deps.settings().wakePress === 'swallow';
    if (swallow && tag) this.swallowed.add(tag);
    return swallow;
  }

  onAppAttached(): void {
    // The client app is re-announced after connect; a stale 'bitfocus' must not stick.
    this.clientApp = 'unknown';
    this.sessionSeen = true;
    this.clearGone();
    this.recompute();
  }

  onAppDetached(): void {
    this.clientApp = 'unknown';
    if (this.deps.settings().appGoneAction === 'none') return;
    this.armDebounce(true);
  }

  onClientApp(app: ClientApp): void {
    this.clientApp = app;
  }

  /** O(1): a CORA frame proves the app is alive; the exit itself is deferred. */
  noteAppTraffic(): void {
    if (!this.detachedGone && !this.silent) return;
    if (this.exitTimer !== undefined) return;
    this.exitTimer = this.clock.setTimeout(() => {
      this.exitTimer = undefined;
      this.clearGone();
      this.recompute();
    }, 0);
  }

  /** `applied`: the level the caller already wrote to the fresh driver (before the
   *  splash), so an uncapped attach doesn't write it twice; absent = write now. */
  onDriverAttached(applied?: number): void {
    const now = this.clock.now();
    this.attached = true;
    this.lastInputAt = now;
    // A fresh open is awake: start from scratch without firing sleep/wake hooks.
    this.off = false;
    this.sleeping = false;
    this.lastApplied = applied;
    // The identity (and so the settings) of a primary dock can arrive after construction.
    this.syncTimers();
    this.recompute(applied === undefined, true);
  }

  onDriverDetached(): void {
    this.attached = false;
    this.sleeping = false;
    this.lastApplied = undefined;
    this.inStandby = false;
    this.painted = false;
    this.swallowed.clear();
    this.clearTimer('wakeTimer');
    this.res = this.evaluate(this.clock.now());
  }

  /** Mirabox 'reinit': firmware reset the level (and woke the panel). */
  onDeviceReinit(): void {
    this.recompute(true);
  }

  /** Settings changed (WebUI/import): the user is at the app, so count it as activity. */
  reload(): void {
    this.lastInputAt = this.clock.now();
    this.syncTimers();
    this.recompute();
  }

  stop(): void {
    this.clearTimer('tickTimer');
    this.clearTimer('debounceTimer');
    this.clearTimer('exitTimer');
    this.clearTimer('wakeTimer');
  }

  private featuresOn(): boolean {
    const s = this.deps.settings();
    return s.idleDim || s.offWhenIdle || s.appGoneAction !== 'none' || s.night;
  }

  private clearTimer(name: 'tickTimer' | 'debounceTimer' | 'exitTimer' | 'wakeTimer'): void {
    const h = this[name];
    if (h === undefined) return;
    if (name === 'tickTimer') this.clock.clearInterval(h);
    else this.clock.clearTimeout(h);
    this[name] = undefined;
  }

  private clearGone(): void {
    this.clearTimer('debounceTimer');
    this.detachedGone = false;
    this.silent = false;
  }

  /** The tick runs only while a feature needs it; with the app absent at start the
   *  debounce runs from construction (no detach event ever arrives then). */
  private syncTimers(): void {
    if (!this.featuresOn()) this.clearTimer('tickTimer');
    else if (this.tickTimer === undefined) {
      this.lastTickAt = this.clock.now();
      this.tickTimer = this.clock.setInterval(() => this.tick(), this.timing.tickMs);
    }
    if (this.deps.settings().appGoneAction === 'none') this.clearGone();
    else if (!this.deps.link.childHasClient() && !this.detachedGone) this.armDebounce(false);
  }

  private armDebounce(restart: boolean): void {
    if (this.debounceTimer !== undefined) {
      if (!restart) return;
      this.clearTimer('debounceTimer');
    }
    this.debounceTimer = this.clock.setTimeout(() => {
      this.debounceTimer = undefined;
      if (this.deps.link.childHasClient()) return;
      this.detachedGone = true;
      this.recompute();
    }, this.timing.appGoneDebounceMs);
  }

  /** The app-gone action in force: the preconditions of the design (D3, D14) applied. */
  private actionInForce(s: StandbySettings, now: number): 'none' | 'clock' | 'off' {
    const a = s.appGoneAction;
    if (a === 'none' || !this.attached || !(this.detachedGone || this.silent)) return 'none';
    if (!this.sessionSeen && !this.deps.pairedBefore()) return 'none';
    if (now - this.bornAt < this.timing.bootGraceMs) return 'none';
    return a === 'clock' && !this.deps.canShowClock() ? 'off' : a;
  }

  private evaluate(now: number): CapResult & { action: 'none' | 'clock' | 'off' } {
    const s = this.deps.settings();
    const idleFor = now - this.lastInputAt;
    const night = s.night ? this.inNight(s, now) : false;
    const action = this.actionInForce(s, now);
    const r = computeDisplay({
      requested: this.requested,
      idle: idleFor >= s.idleMinutes * this.timing.minuteMs,
      offIdle: s.offWhenIdle && idleFor >= s.offMinutes * this.timing.minuteMs,
      nightActive: night,
      appGone: action,
      settings: s,
    });
    return { ...r, action };
  }

  private inNight(s: StandbySettings, now: number): boolean {
    const [from, to] = [parseHhmm(s.nightStart), parseHhmm(s.nightEnd)];
    if (from === undefined || to === undefined) return false;
    return inNightWindow(this.clock.localMinuteOfDay(now), from, to);
  }

  private tick(): void {
    const now = this.clock.now();
    let force = false;
    // A frozen process (host sleep) leaves a gap; the user's return is activity.
    if (now - this.lastTickAt > this.timing.hostResumeGapMs) {
      this.lastInputAt = now;
      force = true;
    }
    this.lastTickAt = now;
    const link = this.deps.link;
    const limit = this.timing.silenceMs;
    // Companion's rx cadence is unknown, so it is exempt.
    this.silent =
      limit > 0 &&
      this.deps.settings().appGoneAction !== 'none' &&
      this.clientApp !== 'bitfocus' &&
      link.childHasClient() &&
      link.childRxIdleMs() > limit;
    this.recompute(force);
    const minute = Math.floor(now / this.timing.minuteMs);
    if (this.painted && this.res.effective > 0 && minute !== this.lastPaintMinute) {
      this.lastPaintMinute = minute;
      this.deps.sink.paintStandby(now);
    }
  }

  /** Apply `evaluate()` to the world: standby painter, backlight/sleep, hooks, status.
   *  `force` re-writes the level even when unchanged; `quiet` skips sleep/wake hooks. */
  private recompute(force = false, quiet = false): void {
    const now = this.clock.now();
    const { action, ...r } = this.evaluate(now);
    const prev = this.res;
    this.res = r;
    if (this.attached) {
      this.apply(r, action === 'clock', force, quiet, now);
      this.runPendingWake();
    }
    if (!this.muted && (r.state !== prev.state || r.effective !== prev.effective)) {
      this.deps.sink.changed();
    }
  }

  private apply(r: CapResult, wantStandby: boolean, force: boolean, quiet: boolean, now: number) {
    const isOff = r.state === 'off';
    const wasOff = this.off;
    const wasSleeping = this.sleeping;
    // Restore the app's frames before raising the backlight, paint the clock after lowering it.
    if (!wantStandby && this.inStandby) {
      this.inStandby = false;
      if (this.painted) this.deps.sink.exitStandby();
      this.painted = false;
    }
    this.writeBacklight(r.effective, isOff, force);
    this.off = isOff;
    if (isOff && !wasOff && !quiet) {
      this.wakePending = true;
      this.deps.sink.runHook('sleep');
    }
    if (wantStandby && !this.inStandby) {
      this.inStandby = true;
      this.startPainter(now);
    }
    if (wasOff && !isOff) this.scheduleWake(wasSleeping);
  }

  /** Off = hardware sleep where the model has it (offMode 'auto'), else level 0. */
  private writeBacklight(level: number, isOff: boolean, force: boolean): void {
    const { sink } = this.deps;
    const wantSleep = isOff && this.deps.canSleep() && this.deps.settings().offMode === 'auto';
    let write = force;
    if (this.sleeping && !wantSleep) {
      sink.setSleep(false);
      this.sleeping = false;
      write = true;
    }
    if (wantSleep) {
      if (!this.sleeping || force) sink.setSleep(true);
      this.sleeping = true;
      this.lastApplied = 0;
    } else if (write || level !== this.lastApplied) {
      sink.applyBrightness(level);
      this.lastApplied = level;
    }
  }

  private startPainter(now: number): void {
    // Nothing is drawn while off; the wake path starts the painter then.
    if (this.res.state === 'off') return;
    this.painted = true;
    this.lastPaintMinute = Math.floor(now / this.timing.minuteMs);
    this.deps.sink.enterStandby();
  }

  /** Awake again without the wake path (quiet re-attach): still owes the wake hook. */
  private runPendingWake(): void {
    if (!this.wakePending || this.off || this.wakeTimer !== undefined) return;
    this.wakePending = false;
    this.deps.sink.runHook('wake');
  }

  /** Deferred so noteInput stays O(1) on the input path. */
  private scheduleWake(afterSleep: boolean): void {
    this.clearTimer('wakeTimer');
    this.wakeTimer = this.clock.setTimeout(() => {
      this.wakeTimer = undefined;
      const { sink } = this.deps;
      sink.wakeRepaint(afterSleep);
      if (this.inStandby) {
        const now = this.clock.now();
        this.lastPaintMinute = Math.floor(now / this.timing.minuteMs);
        // A hardware sleep (or an unpainted entry) lost the grid: draw it from scratch.
        if (afterSleep || !this.painted) sink.enterStandby();
        else sink.paintStandby(now);
        this.painted = true;
      }
      this.wakePending = false;
      sink.runHook('wake');
    }, 0);
  }
}

export interface DockStandbyHost {
  index: number;
  driver: () => DockDriver | null;
  frames: LastFrames;
  mirror?: (key: number, data: Buffer, format: ImageFormat) => void;
  widgets: () => ExtraKeyWidgets | null;
  settings: () => StandbySettings;
  pairedBefore: () => boolean;
  cora: Pick<CoraDock, 'childHasClient' | 'childRxIdleMs'>;
  changed: () => void;
  clock?: StandbyClock;
  timing?: StandbyTiming;
}

/** A dock's DockStandby wired to its driver, frames, widgets and the clock painter. */
export function createDockStandby(h: DockStandbyHost): DockStandby {
  const timing = h.timing ?? standbyTiming();
  const clock = h.clock ?? SYSTEM_CLOCK;
  const painter = new StandbyClockPainter({
    driver: h.driver,
    frames: h.frames,
    mirror: h.mirror,
    appOwnedZones: () => h.widgets()?.appOwnedZones() ?? [],
    timing,
  });
  const runHook = createStandbyHooks(h.index, h.settings);
  const standby: DockStandby = new DockStandby({
    settings: h.settings,
    pairedBefore: h.pairedBefore,
    canSleep: () => !!h.driver()?.model.sleep,
    canShowClock: () => h.driver()?.paintsSplash !== false,
    link: {
      childHasClient: () => h.cora.childHasClient,
      childRxIdleMs: () => h.cora.childRxIdleMs,
    },
    clock,
    timing,
    sink: {
      applyBrightness: (level) => h.driver()?.setBrightness(level),
      setSleep: (asleep) => h.driver()?.setSleep?.(asleep),
      enterStandby: () => painter.start(clock.now()),
      exitStandby: () => painter.stop(),
      paintStandby: (now) => painter.paint(now),
      wakeRepaint(afterSleep) {
        const driver = h.driver();
        // In standby the clock painter redraws the grid right after, so skip the frames.
        if (afterSleep && driver && standby.state !== 'standby') {
          sendSplashImages(driver);
          h.frames.repaint(driver, h.mirror);
        }
        h.widgets()?.repaint();
      },
      runHook,
      changed: h.changed,
    },
  });
  return standby;
}
