// In-memory session counters behind the extension's `snapshot` route. Pure: the clock is
// injected and the activity ring advances lazily, so there are no timers.
import type { DeckSource, KeyState } from '../../extension/api.js';
import type { DeckCounters, DeckStats, StatsSnapshot } from './contract.js';

export const ACTIVITY_BUCKETS = 15;
export const ACTIVITY_BUCKET_MS = 60_000;
const MAX_DECKS = 16;

function zeros(n: number): number[] {
  return Array.from({ length: n }, () => 0);
}

/** Per-minute press ring; the last bucket is the minute of the latest write/read. */
class ActivityRing {
  private buckets = zeros(ACTIVITY_BUCKETS);
  private minute: number;

  constructor(now: number) {
    this.minute = Math.floor(now / ACTIVITY_BUCKET_MS);
  }

  private advance(now: number): void {
    const elapsed = Math.floor(now / ACTIVITY_BUCKET_MS) - this.minute;
    if (elapsed <= 0) return; // clock stepped back: keep writing to the current bucket
    this.minute += elapsed;
    if (elapsed >= ACTIVITY_BUCKETS) this.buckets.fill(0);
    else this.buckets = [...this.buckets.slice(elapsed), ...zeros(elapsed)];
  }

  add(now: number): void {
    this.advance(now);
    this.buckets[ACTIVITY_BUCKETS - 1] = (this.buckets[ACTIVITY_BUCKETS - 1] ?? 0) + 1;
  }

  read(now: number): number[] {
    this.advance(now);
    return [...this.buckets];
  }
}

class Counters {
  keyPresses = 0;
  dialPresses = 0;
  dialDetents = 0;
  imagesProcessed = 0;
  cacheHits = 0;
  reconnects = 0;
  readonly ring: ActivityRing;

  constructor(now: number) {
    this.ring = new ActivityRing(now);
  }

  view(now: number): DeckCounters {
    return {
      keyPresses: this.keyPresses,
      dialPresses: this.dialPresses,
      dialDetents: this.dialDetents,
      imagesProcessed: this.imagesProcessed,
      cacheHits: this.cacheHits,
      reconnects: this.reconnects,
      activity: this.ring.read(now),
    };
  }
}

class DeckRecord extends Counters {
  source: DeckSource = 'usb';
  hasEncoders = false;
  readonly labels = new Map<string, number>();
  readonly pressed = new Set<string>();
  lastEvent: number;

  constructor(
    readonly deviceKey: string,
    public modelName: string,
    now: number,
  ) {
    super(now);
    this.lastEvent = now;
  }
}

export class SessionStats {
  readonly startedAt: number;
  private readonly totals: Counters;
  private readonly decks = new Map<string, DeckRecord>();

  constructor(
    private readonly appStartedAt: number,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
    this.totals = new Counters(this.startedAt);
  }

  deckConnected(
    deviceKey: string,
    modelName: string,
    source: DeckSource,
    hasEncoders: boolean,
  ): void {
    if (deviceKey === '') return;
    const seen = this.decks.has(deviceKey);
    const deck = this.deck(deviceKey);
    if (seen) {
      deck.reconnects++;
      this.totals.reconnects++;
    }
    deck.modelName = modelName;
    deck.source = source;
    deck.hasEncoders = hasEncoders;
    deck.pressed.clear();
  }

  key(deviceKey: string, label: string, state: KeyState): void {
    if (deviceKey === '') return;
    const deck = this.deck(deviceKey);
    if (state !== 'down') {
      deck.pressed.delete(label);
      return;
    }
    if (deck.pressed.has(label)) return;
    deck.pressed.add(label);
    const at = this.now();
    deck.keyPresses++;
    this.totals.keyPresses++;
    deck.labels.set(label, (deck.labels.get(label) ?? 0) + 1);
    deck.ring.add(at);
    this.totals.ring.add(at);
  }

  dialPress(deviceKey: string, state: KeyState): void {
    if (deviceKey === '') return;
    const deck = this.deck(deviceKey);
    if (state !== 'down') return;
    deck.dialPresses++;
    this.totals.dialPresses++;
  }

  dialRotate(deviceKey: string, delta: number): void {
    if (deviceKey === '') return;
    const deck = this.deck(deviceKey);
    deck.dialDetents += Math.abs(delta);
    this.totals.dialDetents += Math.abs(delta);
  }

  imageProcessed(deviceKey: string, cached: boolean): void {
    if (deviceKey === '') return;
    const deck = this.deck(deviceKey);
    deck.imagesProcessed++;
    this.totals.imagesProcessed++;
    if (cached) {
      deck.cacheHits++;
      this.totals.cacheHits++;
    }
  }

  snapshot(): StatsSnapshot {
    const at = this.now();
    const decks: DeckStats[] = [];
    for (const d of this.decks.values()) {
      decks.push({
        ...d.view(at),
        deviceKey: d.deviceKey,
        modelName: d.modelName,
        source: d.source,
        hasEncoders: d.hasEncoders,
        keys: [...d.labels]
          .map(([label, count]) => ({ label, count }))
          .toSorted((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
      });
    }
    return {
      startedAt: this.startedAt,
      appStartedAt: this.appStartedAt,
      at,
      uptimeMs: at - this.startedAt,
      totals: this.totals.view(at),
      decks,
    };
  }

  /** Get-or-create, touching lastEvent; evicts the stalest record past the cap. */
  private deck(deviceKey: string): DeckRecord {
    const at = this.now();
    let deck = this.decks.get(deviceKey);
    if (!deck) {
      if (this.decks.size >= MAX_DECKS) this.evictOldest();
      deck = new DeckRecord(deviceKey, deviceKey, at);
      this.decks.set(deviceKey, deck);
    }
    deck.lastEvent = at;
    return deck;
  }

  private evictOldest(): void {
    let oldest: DeckRecord | undefined;
    for (const d of this.decks.values()) if (!oldest || d.lastEvent < oldest.lastEvent) oldest = d;
    if (oldest) this.decks.delete(oldest.deviceKey);
  }
}
