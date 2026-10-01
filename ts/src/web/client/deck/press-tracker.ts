// Merges pointers into per-key transitions: two fingers on one key send one down and one
// up (when the last lifts), like the server's HeldKeys does across pages.
export interface KeyTransition {
  key: number;
  state: 'down' | 'up';
}

export class PressTracker {
  /** pointer/touch id → the key it started on (a press stays bound to that key). */
  private readonly keyOf = new Map<number, number>();
  private readonly holders = new Map<number, number>();

  down(pointerId: number, key: number): KeyTransition[] {
    if (this.keyOf.has(pointerId)) return [];
    this.keyOf.set(pointerId, key);
    const n = (this.holders.get(key) ?? 0) + 1;
    this.holders.set(key, n);
    return n === 1 ? [{ key, state: 'down' }] : [];
  }

  up(pointerId: number): KeyTransition[] {
    const key = this.keyOf.get(pointerId);
    if (key === undefined) return [];
    this.keyOf.delete(pointerId);
    const n = (this.holders.get(key) ?? 1) - 1;
    if (n > 0) {
      this.holders.set(key, n);
      return [];
    }
    this.holders.delete(key);
    return [{ key, state: 'up' }];
  }

  /** A cancelled pointer releases like a lift: the key must not stay down. */
  cancel(pointerId: number): KeyTransition[] {
    return this.up(pointerId);
  }

  /** Releases everything held; returns the keys that were down. */
  releaseAll(): KeyTransition[] {
    const out: KeyTransition[] = [];
    // toSorted is newer than the oldest supported Safari (build.mjs legacy denylist).
    // oxlint-disable-next-line unicorn/no-array-sort -- legacy bundle, see above
    for (const key of Array.from(this.holders.keys()).sort((a, b) => a - b)) {
      out.push({ key, state: 'up' });
    }
    this.keyOf.clear();
    this.holders.clear();
    return out;
  }
}
