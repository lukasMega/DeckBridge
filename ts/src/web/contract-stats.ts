// Statistics wire DTO (GET /api/stats); session-only counters, never persisted.

/** Where a deck's input comes from; images and cache are measured only for 'usb'. */
export type DeckSource = 'usb' | 'browser' | 'mock';

export interface DeckCounters {
  keyPresses: number;
  dialPresses: number;
  dialDetents: number;
  imagesProcessed: number;
  cacheHits: number;
  reconnects: number;
  /** Presses per minute, oldest first; the last bucket is the current, partial minute. */
  activity: number[];
}

export interface DeckStats extends DeckCounters {
  deviceKey: string;
  modelName: string;
  source: DeckSource;
  hasEncoders: boolean;
  /** Most-pressed first. */
  keys: { label: string; count: number }[];
}

/** GET /api/stats. */
export interface StatsSnapshot {
  startedAt: number; // epoch ms; changes on process restart
  at: number; // snapshot time, epoch ms
  uptimeMs: number;
  totals: DeckCounters;
  decks: DeckStats[]; // first-seen order
}
