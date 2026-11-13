// Manual StandbyClock for tests: advance() fires due timers in order, jump() skips
// time silently (a frozen process).
import type { StandbyClock } from '../../src/main/standby-policy.js';

interface Timer {
  id: number;
  due: number;
  fn: () => void;
  every?: number;
}

/** Manual clock: advance() fires due timers in order, jump() skips time silently. */
export class FakeClock implements StandbyClock {
  t = 1_000_000;
  minute = 12 * 60;
  private timers: Timer[] = [];
  private nextId = 1;
  now = (): number => this.t;
  localMinuteOfDay = (): number => this.minute;
  setInterval(fn: () => void, ms: number): unknown {
    return this.add(fn, ms, ms);
  }
  setTimeout(fn: () => void, ms: number): unknown {
    return this.add(fn, ms);
  }
  clearInterval(h: unknown): void {
    this.timers = this.timers.filter((x) => x.id !== h);
  }
  clearTimeout(h: unknown): void {
    this.clearInterval(h);
  }
  private add(fn: () => void, ms: number, every?: number): number {
    const id = this.nextId++;
    this.timers.push({ id, due: this.t + ms, fn, every });
    return id;
  }
  pending(): number {
    return this.timers.length;
  }
  pendingIntervals(): number {
    return this.timers.filter((x) => x.every !== undefined).length;
  }
  jump(ms: number): void {
    this.t += ms;
  }
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const due = this.timers
        .filter((x) => x.due <= end)
        .toSorted((a, b) => a.due - b.due || a.id - b.id);
      const next = due[0];
      if (!next) break;
      this.t = Math.max(this.t, next.due);
      if (next.every === undefined) this.timers = this.timers.filter((x) => x !== next);
      else next.due = this.t + next.every;
      next.fn();
    }
    this.t = end;
  }
}
