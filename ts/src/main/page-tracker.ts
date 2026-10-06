// Tells which saved Elgato page the deck shows, from the per-key frame hashes the USB
// worker already computes. Hashing is not done here: noteFrame is O(1) per CORA frame.
// Timing rules: docs/side-keys.md "Layouts that follow the Elgato page".
import {
  PAGE_ANIMATED_GAP_MS,
  PAGE_MAX_WAIT_MS,
  PAGE_SETTLE_MS,
  isHeldVector,
  pickWinner,
  rankPages,
  suggestIgnore,
} from '../shared/page-match.js';
import type { PageObservation, PageScore } from '../shared/page-match.js';
import type { PageDefinition } from '../shared/page-config.js';

type TimerHandle = Parameters<typeof clearTimeout>[0];

/** Clock seam so tests drive the settle timers by hand. */
export interface PageTrackerClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

const REAL_CLOCK: PageTrackerClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

export interface PageTrackerDeps {
  pages(): readonly PageDefinition[];
  /** Advertised CORA profile id + grid size (what the Elgato app addresses). */
  geometry(): { profile: string; keyCount: number; columns: number };
  /** The active page changed; undefined = the default layout. */
  onActiveChange(page: PageDefinition | undefined): void;
  onObservation?(obs: PageObservation): void;
  log?(level: 'info' | 'debug', message: string): void;
  clock?: PageTrackerClock;
}

type EvalKind = 'quiet' | 'forced' | 'reload';

export class PageTracker {
  private hashes: (string | null)[] = [];
  private lastFrameAt: (number | undefined)[] = [];
  private readonly animated = new Set<number>();
  private activeId: string | null = null;
  /** A forced (mid-burst) result waits for a second agreeing one; undefined = none. */
  private pendingId: string | null | undefined;
  private lastQuietBreakAt = 0;
  private settleTimer: TimerHandle | null = null;
  private maxWaitTimer: TimerHandle | null = null;
  private stopped = false;
  /** The last pushed verdict: re-published when only `settling` flips. */
  private lastHeld = true;
  private lastScores: PageScore[] = [];
  private readonly clock: PageTrackerClock;

  constructor(private readonly deps: PageTrackerDeps) {
    this.clock = deps.clock ?? REAL_CLOCK;
  }

  noteFrame(key: number, hash: string): void {
    if (this.stopped) return;
    const { keyCount } = this.deps.geometry();
    if (key < 0 || key >= keyCount) return;
    if (this.hashes.length !== keyCount) this.resize(keyCount);
    // Replays and tuning repaints are not animation or page changes.
    if (this.hashes[key] === hash) return;
    const now = this.clock.now();
    const prev = this.lastFrameAt[key];
    this.lastFrameAt[key] = now;
    const animated = prev !== undefined && now - prev < PAGE_ANIMATED_GAP_MS;
    if (animated) this.animated.add(key);
    else this.animated.delete(key);
    this.hashes[key] = hash;
    if (!animated) {
      this.lastQuietBreakAt = now;
      if (this.settleTimer === null) {
        this.settleTimer = this.clock.setTimeout(() => this.onSettleTimer(), PAGE_SETTLE_MS);
        // Publish settling at once: a snapshot read between frames must not save the old page.
        this.push(this.lastHeld, this.lastScores);
      }
    }
    this.armMaxWait();
  }

  /** The app is gone or the model changed: forget the frames, keep the shown layout unless
   *  it was saved for another profile or grid. */
  reset(): void {
    if (this.stopped) return;
    this.clearTimers();
    this.hashes = [];
    this.lastFrameAt = [];
    this.animated.clear();
    this.pendingId = undefined;
    const page = this.activePage();
    const { profile, keyCount } = this.deps.geometry();
    if (page && (page.profile !== profile || page.keyCount !== keyCount))
      this.commit(null, undefined);
    this.push(true, []);
  }

  /** Saved pages changed (snapshot, edit, import): re-resolve without waiting for frames. */
  reload(): boolean {
    if (this.stopped) return false;
    // Edits must not turn a half-updated vector into an immediate page switch.
    this.pendingId = undefined;
    if (this.settleTimer !== null) return false;
    const previous = this.activeId;
    if (this.activeId !== null && !this.activePage() && isHeldVector(this.hashes)) {
      this.commit(null, undefined);
    }
    this.evaluate('reload');
    return this.activeId !== previous;
  }

  /** The active page resolved live: a deleted page is the default layout. */
  activePage(): PageDefinition | undefined {
    return this.activeId === null
      ? undefined
      : this.deps.pages().find((p) => p.id === this.activeId);
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
  }

  private resize(keyCount: number): void {
    this.hashes = Array.from({ length: keyCount }, (_, i) => this.hashes[i] ?? null);
    this.lastFrameAt = [];
    this.animated.clear();
  }

  private armMaxWait(): void {
    this.maxWaitTimer ??= this.clock.setTimeout(() => this.evaluate('forced'), PAGE_MAX_WAIT_MS);
  }

  private onSettleTimer(): void {
    this.settleTimer = null;
    const quietFor = this.clock.now() - this.lastQuietBreakAt;
    if (quietFor >= PAGE_SETTLE_MS) this.evaluate('quiet');
    else
      this.settleTimer = this.clock.setTimeout(
        () => this.onSettleTimer(),
        PAGE_SETTLE_MS - quietFor,
      );
  }

  private clearTimers(): void {
    for (const t of [this.settleTimer, this.maxWaitTimer])
      if (t !== null) this.clock.clearTimeout(t);
    this.settleTimer = null;
    this.maxWaitTimer = null;
  }

  private evaluate(kind: EvalKind): void {
    if (this.stopped) return;
    if (this.maxWaitTimer !== null) this.clock.clearTimeout(this.maxWaitTimer);
    this.maxWaitTimer = null;
    // A forced result lands mid-burst: the settle timer keeps running for the quiet one.
    if (kind !== 'forced' && this.settleTimer !== null) this.clock.clearTimeout(this.settleTimer);
    if (kind !== 'forced') this.settleTimer = null;

    if (isHeldVector(this.hashes)) {
      this.push(true, []);
      return;
    }
    const { profile, keyCount } = this.deps.geometry();
    const pages = this.deps.pages();
    const scores = rankPages(pages, this.hashes, profile, keyCount);
    const winner = pickWinner(scores, pages);
    const candidate = winner?.pageId ?? null;
    if (candidate === this.activeId) this.pendingId = undefined;
    else if (kind !== 'forced' || this.pendingId === candidate) this.commit(candidate, winner);
    else this.pendingId = candidate;
    // A pending result needs its confirming evaluation even if no further frame arrives.
    if (this.pendingId !== undefined) this.armMaxWait();
    this.push(false, scores);
  }

  private commit(id: string | null, winner: PageScore | undefined): void {
    this.activeId = id;
    this.pendingId = undefined;
    const page = this.activePage();
    const what =
      page && winner
        ? `"${page.name}" (${winner.matched}/${winner.considered} keys)`
        : 'default layout';
    this.deps.log?.('info', `Elgato page -> ${what}`);
    this.deps.onActiveChange(page);
  }

  private push(held: boolean, scores: PageScore[]): void {
    this.lastHeld = held;
    this.lastScores = scores;
    const { profile, keyCount, columns } = this.deps.geometry();
    this.deps.onObservation?.({
      profile,
      keyCount,
      columns,
      hashes: [...this.hashes],
      activePageId: this.activePage()?.id ?? null,
      scores,
      suggestedIgnore: suggestIgnore(this.hashes, this.animated),
      settling: this.settleTimer !== null,
      held,
    });
  }
}
