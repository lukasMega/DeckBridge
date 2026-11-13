// Client and server clocks differ, so a late press is measured against the session's own
// best-case offset: lateness = (serverNow - clientNow) - minimum offset seen recently.
import { FRESHNESS_BUCKET_MS, FRESHNESS_WINDOW_MS, LATENCY_WINDOW_SIZE } from './deck-constants.js';

export class InputFreshness {
  private buckets: { start: number; min: number }[] = [];

  /** Call after `lateness` for the same message so a delayed message never sets its own baseline. */
  sample(clientNow: number, serverNow: number): void {
    const offset = serverNow - clientNow;
    const start = Math.floor(serverNow / FRESHNESS_BUCKET_MS) * FRESHNESS_BUCKET_MS;
    const last = this.buckets[this.buckets.length - 1];
    if (last && last.start === start) last.min = Math.min(last.min, offset);
    else this.buckets.push({ start, min: offset });
    this.buckets = this.buckets.filter((b) => b.start > serverNow - FRESHNESS_WINDOW_MS);
  }

  /** 0 until a baseline exists (the hello message seeds it). */
  lateness(clientNow: number, serverNow: number): number {
    if (this.buckets.length === 0) return 0;
    const min = Math.min(...this.buckets.map((b) => b.min));
    return Math.max(0, serverNow - clientNow - min);
  }
}

/** Last N accepted-press latenesses; percentiles by nearest rank. */
export class LatencyWindow {
  private readonly values: number[] = [];

  add(ms: number): void {
    this.values.push(ms);
    if (this.values.length > LATENCY_WINDOW_SIZE) this.values.shift();
  }

  get count(): number {
    return this.values.length;
  }

  p50(): number | undefined {
    return this.percentile(0.5);
  }

  p95(): number | undefined {
    return this.percentile(0.95);
  }

  private percentile(p: number): number | undefined {
    if (this.values.length === 0) return undefined;
    const sorted = this.values.toSorted((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  }
}
