// Pure maths + timing for standby / burn-in care: brightness caps, night window,
// pixel-shift orbit and standby-clock slots. No I/O; the clock is injectable so
// tests never wait real minutes. Controller: main/dock-standby.ts.
import type { DisplayState, StandbyAppGoneAction, StandbySettings } from '../shared/types.js';

export interface StandbyClock {
  now(): number;
  /** Local wall-clock minute of day (0..1439) for `ms` — Date#getHours/getMinutes. */
  localMinuteOfDay(ms: number): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const SYSTEM_CLOCK: StandbyClock = {
  now: () => Date.now(),
  localMinuteOfDay(ms) {
    const d = new Date(ms);
    return d.getHours() * 60 + d.getMinutes();
  },
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (h) => globalThis.clearInterval(h as number),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as number),
};

export interface StandbyTiming {
  minuteMs: number;
  tickMs: number;
  appGoneDebounceMs: number;
  bootGraceMs: number;
  /** 0 = CORA-silence detection off. */
  silenceMs: number;
  hostResumeGapMs: number;
  pixelShiftPeriodMs: number;
}

export const DEFAULT_TIMING: StandbyTiming = {
  minuteMs: 60_000,
  tickMs: 1_000,
  appGoneDebounceMs: 15_000,
  bootGraceMs: 60_000,
  silenceMs: 30_000,
  hostResumeGapMs: 30_000,
  pixelShiftPeriodMs: 300_000,
};

const FAST_TIMING: StandbyTiming = {
  ...DEFAULT_TIMING,
  minuteMs: 1_000,
  tickMs: 250,
  appGoneDebounceMs: 1_000,
  bootGraceMs: 1_000,
  // The e2e CORA client never sends anything.
  silenceMs: 0,
  pixelShiftPeriodMs: 5_000,
};

/** DECKBRIDGE_STANDBY_FAST=1 is honored in mock builds only, so a release
 *  binary can't be sped up by a stray env var. */
export function standbyTiming(): StandbyTiming {
  return __MOCK_BUILD__ && tjs.env['DECKBRIDGE_STANDBY_FAST'] === '1'
    ? FAST_TIMING
    : DEFAULT_TIMING;
}

/** `minuteOfDay` inside [start, end); end < start means the window crosses midnight.
 *  Evaluated from the wall clock on every tick, so DST jumps can't make it drift. */
export function inNightWindow(minuteOfDay: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end
    ? minuteOfDay >= start && minuteOfDay < end
    : minuteOfDay >= start || minuteOfDay < end;
}

export interface CapInput {
  requested: number;
  /** No input for idleMinutes (regardless of idleDim: night-off uses it too). */
  idle: boolean;
  /** Already gated on settings.offWhenIdle and offMinutes by the caller. */
  offIdle: boolean;
  /** Already gated on settings.night and the wall-clock window by the caller. */
  nightActive: boolean;
  /** Effective app-gone action after preconditions + browser-deck fallback; 'none' = app present. */
  appGone: StandbyAppGoneAction;
  settings: StandbySettings;
}
export interface CapResult {
  effective: number;
  state: DisplayState;
}

function idleCap(i: CapInput): number {
  const s = i.settings;
  if (i.offIdle || (i.idle && i.nightActive && s.nightOffWhenIdle)) return 0;
  return i.idle && s.idleDim ? s.idleLevel : 100;
}

function standbyCap(i: CapInput): number {
  if (i.appGone === 'clock') return i.settings.clockLevel;
  return i.appGone === 'off' ? 0 : 100;
}

/** effective = min(requested, capIdle, capNight, capStandby), plus the reported state.
 *  'dimmed' outranks 'night' only when the idle cap is what lowers the level. */
export function computeDisplay(i: CapInput): CapResult {
  const { requested } = i;
  const capNight = i.nightActive ? i.settings.nightLevel : 100;
  const capIdle = idleCap(i);
  const effective = Math.min(requested, capIdle, capNight, standbyCap(i));
  // Requested 0 is the app's or user's own choice, not a screen-off we caused.
  if (effective === 0 && requested > 0) return { effective, state: 'off' };
  if (i.appGone === 'clock') return { effective, state: 'standby' };
  if (capIdle < requested && capIdle < capNight) return { effective, state: 'dimmed' };
  return { effective, state: i.nightActive ? 'night' : 'active' };
}

/** 1-px orbit; the offsets are added to a 1-px margin (see shiftLayout users). */
export const PIXEL_SHIFT_ORBIT: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
];

/** Epoch-aligned, so with a period that is a multiple of 60 s an offset change
 *  lands on the same tick as a clock widget's minute change. */
export function pixelShiftAt(nowMs: number, periodMs: number): readonly [number, number] {
  const step = Math.floor(nowMs / periodMs);
  return PIXEL_SHIFT_ORBIT[((step % 8) + 8) % 8]!;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** Starting mk2 index of the clock key (and date key to its right when
 *  columns >= 2) for minute `n`. Stateless: slot = n*step+3 over the legal
 *  starts, step coprime to the slot count so every slot gets visited. */
export function clockSlotAt(n: number, columns: number, keyCount: number): number {
  if (keyCount <= 1) return 0;
  const pairs = columns >= 2;
  const rows = pairs ? Math.max(1, Math.floor(keyCount / columns)) : 1;
  const slotCount = pairs ? Math.max(1, rows * (columns - 1)) : keyCount;
  let step = 7;
  while (gcd(step, slotCount) !== 1) step++;
  const slot = (((n % slotCount) + slotCount) % slotCount) * step + 3;
  const s = slot % slotCount;
  if (!pairs) return s;
  const index = Math.floor(s / (columns - 1)) * columns + (s % (columns - 1));
  return Math.min(index, keyCount - 1);
}
