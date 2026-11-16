/** The adapter between CORA's per-key image pushes and the D200's per-PAGE
 *  transfer unit. CORA sends one image per key; the device takes one ZIP for the
 *  whole grid, so images are staged into a dirty set, coalesced by a debounce,
 *  and turned into either a full page (every slot we have ever sent) or a
 *  partial one (only what changed).
 *
 *  Deliberately free of FFI and hidapi: this is the part most likely to need
 *  retuning on real hardware, so it is unit-testable on its own. */

import type { PageSlot } from './ulanzi-zip.js';

export interface PageBatch {
  slots: PageSlot[];
  /** true → send with the full-page opcode (SET_BUTTONS); false → PARTIAL_UPDATE. */
  full: boolean;
}

export class UlanziPage {
  /** Staged since the last successful flush; last write per slot wins. */
  private readonly dirty = new Map<number, Uint8Array>();
  /** Everything successfully sent so far — the page we can repaint from after a
   *  sleep/wake or a reconnect, and the content of a full rebuild. */
  private readonly lastSent = new Map<number, Uint8Array>();
  /** Forces the next batch to be a full page. Set at construction (the first
   *  flush after open must establish the whole grid) and by restoreAll(). */
  private forceFull = true;

  /** @param partialUpdates when false, every flush rebuilds the whole page —
   *  the fallback if the PARTIAL_UPDATE opcode turns out to ghost keys. */
  constructor(private readonly partialUpdates: boolean) {}

  stage(slotId: number, png: Uint8Array): void {
    this.dirty.set(slotId, png);
  }

  hasPending(): boolean {
    return this.dirty.size > 0 || (this.forceFull && this.lastSent.size > 0);
  }

  /** Take the next batch to send, or null when there is nothing to do.
   *  Does NOT consume the dirty set — the caller calls onFlushed() only after
   *  the write succeeded, so a failed write leaves the slots staged for retry. */
  takeBatch(): PageBatch | null {
    if (!this.hasPending()) return null;
    const full = this.forceFull || !this.partialUpdates;
    const source = full ? new Map([...this.lastSent, ...this.dirty]) : this.dirty;
    // Sorted by slot id so a page's bytes depend only on its content, not on the
    // order CORA happened to push the keys in.
    const slots: PageSlot[] = [...source]
      .toSorted((a, b) => a[0] - b[0])
      .map(([slotId, png]) => ({ slotId, png }));
    return { slots, full };
  }

  /** Commit a batch that was written successfully. */
  onFlushed(batch: PageBatch): void {
    for (const slot of batch.slots) {
      if (slot.png) this.lastSent.set(slot.slotId, slot.png);
    }
    this.dirty.clear();
    this.forceFull = false;
  }

  /** Make the next batch a full repaint of everything remembered — used after a
   *  reconnect or a sleep/wake, where the firmware has dropped back to its own
   *  screen and nothing on the panel is ours any more. */
  restoreAll(): void {
    this.forceFull = true;
  }

  /** Drop all state (device closed). */
  reset(): void {
    this.dirty.clear();
    this.lastSent.clear();
    this.forceFull = true;
  }

  /** Slots the device is currently believed to be showing. Diagnostics only. */
  get sentCount(): number {
    return this.lastSent.size;
  }
}

export interface FlushSchedulerOptions {
  /** Coalescing window: how long to wait after a stage before flushing. */
  debounceMs: number;
  /** Floor on the gap between two flushes. A full page is ~180 synchronous HID
   *  writes; unthrottled writers are reported to stall the firmware after ~17
   *  minutes of animation, so this is the cheap prophylactic. */
  minIntervalMs: number;
  /** Injectable clock/timers so the behaviour can be tested without real time. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Debounce + rate limit in front of a flush. One pending flush at a time: while
 *  a timer is armed, further schedule() calls fold into it. */
export class FlushScheduler {
  private timer: unknown = null;
  /** null until the first flush — a fresh scheduler must not behave as if it had
   *  just flushed at time 0 and delay the first page by the min interval. */
  private lastFlushAt: number | null = null;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(
    private readonly opts: FlushSchedulerOptions,
    private readonly onFlush: () => void,
  ) {
    this.now = opts.now ?? ((): number => Date.now());
    this.setTimer = opts.setTimer ?? ((fn, ms): unknown => setTimeout(fn, ms));
    this.clearTimer =
      opts.clearTimer ?? ((h): void => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Arm a flush. The delay is the debounce window, stretched when the previous
   *  flush was too recent to satisfy minIntervalMs. */
  schedule(): void {
    if (this.timer !== null) return;
    const delay =
      this.lastFlushAt === null
        ? this.opts.debounceMs
        : Math.max(this.opts.debounceMs, this.opts.minIntervalMs - (this.now() - this.lastFlushAt));
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.lastFlushAt = this.now();
      this.onFlush();
    }, delay);
  }

  cancel(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }
}
