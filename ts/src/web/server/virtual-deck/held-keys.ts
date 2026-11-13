// Which sessions hold which keys. Mirrored pages pressing one key produce one `down`
// (first holder) and one `up` (last release) toward the Elgato app.

export class HeldKeys {
  private readonly holders = new Map<number, Set<string>>();

  /** True when the transition must be forwarded (the key just became held). */
  down(session: string, key: number): boolean {
    let set = this.holders.get(key);
    if (set?.has(session)) return false;
    if (!set) {
      set = new Set();
      this.holders.set(key, set);
    }
    set.add(session);
    return set.size === 1;
  }

  /** True when the transition must be forwarded (the key just became free). */
  up(session: string, key: number): boolean {
    const set = this.holders.get(key);
    if (!set?.delete(session)) return false;
    if (set.size > 0) return false;
    this.holders.delete(key);
    return true;
  }

  /** Drops every hold of `session`; returns the keys that became free. */
  releaseSession(session: string): number[] {
    const freed: number[] = [];
    for (const key of this.holders.keys()) {
      if (this.up(session, key)) freed.push(key);
    }
    return freed.toSorted((a, b) => a - b);
  }

  isHeld(key: number): boolean {
    return this.holders.has(key);
  }

  heldBy(session: string): number[] {
    return [...this.holders].filter(([, s]) => s.has(session)).map(([k]) => k);
  }
}
