// Manual clock for timer-driven state machines: advance() runs due timers in order.
interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

export class FakeClock {
  private time = 0;
  private nextId = 1;
  private timers: Timer[] = [];

  now = (): number => this.time;

  setTimeout = (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
    const id = this.nextId++;
    this.timers.push({ id, at: this.time + ms, fn });
    return id;
  };

  clearTimeout = (handle: ReturnType<typeof setTimeout>): void => {
    this.timers = this.timers.filter((t) => t.id !== handle);
  };

  get pending(): number {
    return this.timers.length;
  }

  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      const due = this.timers
        .filter((t) => t.at <= end)
        .toSorted((a, b) => a.at - b.at || a.id - b.id);
      const next = due[0];
      if (!next) break;
      this.timers = this.timers.filter((t) => t !== next);
      this.time = Math.max(this.time, next.at);
      next.fn();
    }
    this.time = end;
  }
}
