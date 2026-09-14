// Probe pacing: how often DriverManager re-runs its USB presence sweep.
//
// The sweep is one synchronous HID enumeration on the main thread. On Windows that
// enumeration opens every HID interface on the machine to read its strings, and a
// single unhappy composite device (the keyboards in issue #67.2) can make it take
// seconds. At a fixed 2 s tick the main thread would then spend most of its life
// enumerating — no CORA ACKs, no WebUI, which is exactly what "DeckBridge freezes
// when this keyboard is connected" looks like from the outside.
//
// So the interval adapts: double it while enumeration is slow (capped, so a deck
// plugged in later still connects), snap back to the baseline the moment it isn't.
import { log } from './logger.js';
import { RECONNECT_DELAY_MS } from './types.js';

/** A sweep slower than this means enumeration itself is the bottleneck, not the
 *  devices. 250 ms is an eighth of a normal tick; a healthy machine enumerates in
 *  single-digit ms. */
export const SLOW_ENUMERATE_MS = 250;

/** Ceiling for the backed-off interval. Long enough that a pathological enumeration
 *  can't starve the main thread, short enough that plugging a deck in still connects
 *  without restarting DeckBridge. */
export const RECONNECT_BACKOFF_MAX_MS = 30_000;

/** Pure: the probe interval to use after a sweep whose enumeration took `enumerateMs`. */
export function nextProbeDelayMs(currentMs: number, enumerateMs: number): number {
  if (enumerateMs < SLOW_ENUMERATE_MS) return RECONNECT_DELAY_MS;
  return Math.min(currentMs * 2, RECONNECT_BACKOFF_MAX_MS);
}

/** Current probe interval plus the transition logging. Owns no timer — the caller
 *  reads delayMs when it schedules the next reconnect. */
export class ProbePacer {
  delayMs: number = RECONNECT_DELAY_MS;

  /** The first sweep pays for dlopen + the OS's cold HID stack (~700 ms on a healthy
   *  Mac), which says nothing about how the machine will behave afterwards. */
  private cold = true;

  /** Feed one sweep's enumeration duration; logs only on a change of interval, so a
   *  steadily-slow machine says it once rather than every tick. */
  note(enumerateMs: number): void {
    if (this.cold) {
      this.cold = false;
      return;
    }
    const prev = this.delayMs;
    this.delayMs = nextProbeDelayMs(prev, enumerateMs);
    if (this.delayMs === prev) return;
    const slower = this.delayMs > prev;
    log(
      slower ? 'warn' : 'info',
      'hid',
      `USB enumeration ${slower ? 'slow' : 'recovered'} (${enumerateMs}ms) — device probe interval now ${this.delayMs / 1000}s`,
    );
  }
}
