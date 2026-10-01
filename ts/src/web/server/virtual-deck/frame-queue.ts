// Per-session send window. tjs has no `bufferedAmount`, so the page acks every binary
// frame and the newest frame per key wins while the window is full.

export type QueueItem =
  | { kind: 'frame'; key: number; bytes: Uint8Array }
  | { kind: 'clear'; key: number };

export class FrameQueue {
  private sent = 0;
  private acked = 0;
  private readonly pending = new Map<number, QueueItem>();

  constructor(
    private readonly max: number,
    private readonly send: (item: QueueItem) => void,
  ) {}

  get inFlight(): number {
    return this.sent - this.acked;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  push(item: QueueItem): void {
    // A newer item for the same key replaces the stale one; the stale one is never sent.
    this.pending.delete(item.key);
    this.pending.set(item.key, item);
    this.drain();
  }

  /** Cumulative count of frames the page has received; clamped to what was sent. */
  ack(n: number): void {
    this.acked = Math.max(this.acked, Math.min(n, this.sent));
    this.drain();
  }

  private drain(): void {
    const keys = [...this.pending.keys()].toSorted((a, b) => a - b);
    for (const key of keys) {
      const item = this.pending.get(key)!;
      if (item.kind === 'frame') {
        if (this.inFlight >= this.max) continue;
        this.sent++;
      }
      this.pending.delete(key);
      this.send(item);
    }
  }
}
