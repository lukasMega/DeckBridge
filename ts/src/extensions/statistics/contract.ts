// Statistics wire DTO (GET /api/ext/statistics/snapshot); session-only counters, never persisted.
import type { DeckSource } from '../../extension/api.js';

/** Images and cache are measured only for 'usb' decks. */
export type { DeckSource };

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

/** GET /api/ext/statistics/snapshot. */
export interface StatsSnapshot {
  startedAt: number; // epoch ms: counting began (the extension started)
  appStartedAt: number; // epoch ms: DeckBridge started; changes on process restart
  at: number; // snapshot time, epoch ms
  uptimeMs: number; // at - startedAt
  totals: DeckCounters;
  decks: DeckStats[]; // first-seen order
}
