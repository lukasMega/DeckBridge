// Deck credentials: the one-time pairing exchange and token verification. Tokens are the
// push plan's `dbp_…` records (hashed in settings.json) with scope 'deck'.
import { findPushToken, type PushTokenRecord } from '../../../infra/push-tokens.js';
import type {
  DeckPairRequest,
  DeckPairResponse,
  VirtualDeckDeviceView,
} from '../../contract-deck.js';
import type { PushTokenCreated } from '../../contract.js';
import type { PushRateLimits } from '../push-rate-limit.js';
import type { ReqError } from '../types.js';
import { DECK_DEVICE_NAME_MAX, DECK_DEVICES_MAX } from './deck-constants.js';
import type { PairingCodes } from './pairing-codes.js';

/** What DeckAuth needs from PushController (the single token store). */
export interface DeckTokenStore {
  records(): readonly PushTokenRecord[];
  createToken(name: unknown, scope: 'push' | 'deck'): Promise<PushTokenCreated | ReqError>;
  lastUsedAt(id: string): number | undefined;
  noteUsed(id: string): void;
}

export interface DeckPairResult {
  status: number;
  body: DeckPairResponse | { error: string; code: string };
  /** Retry-After seconds, for 429. */
  retryAfter?: number;
}

const DEFAULT_NAME = 'Browser';

/** Control characters out, whitespace collapsed; falls back to a generic name. */
export function cleanDeviceName(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_NAME;
  const spaced = Array.from(raw, (c) =>
    c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c,
  );
  const name = spaced.join('').replace(/\s+/g, ' ').trim();
  return name.slice(0, DECK_DEVICE_NAME_MAX).trim() || DEFAULT_NAME;
}

export class DeckAuth {
  /** Fired after a successful pairing so the admin panel can close its QR dialog. */
  onPaired: (deviceId: string) => void = () => {};

  constructor(
    private readonly tokens: DeckTokenStore,
    private readonly limits: PushRateLimits,
    private readonly codes: PairingCodes,
    private readonly now: () => number = Date.now,
  ) {}

  async pair(req: DeckPairRequest, remote: string): Promise<DeckPairResult> {
    const wait = this.limits.checkFailedAuth(remote);
    if (wait > 0) {
      return {
        status: 429,
        retryAfter: wait,
        body: { error: 'too many failed attempts', code: 'rate_limited' },
      };
    }
    if (this.deckRecords().length >= DECK_DEVICES_MAX) {
      return {
        status: 409,
        body: { error: `at most ${DECK_DEVICES_MAX} paired devices`, code: 'device_limit' },
      };
    }
    const result = this.codes.consume({ code: req.code, shortCode: req.shortCode }, this.now());
    if (result !== 'ok') this.limits.noteFailedAuth(remote); // spraying with nothing pending counts too
    if (result === 'invalid') {
      return { status: 403, body: { error: 'wrong code', code: 'invalid' } };
    }
    if (result !== 'ok') {
      return {
        status: 410,
        body: { error: 'code expired — create a new one in DeckBridge', code: 'expired' },
      };
    }
    const created = await this.tokens.createToken(cleanDeviceName(req.name), 'deck');
    if ('error' in created) {
      return { status: created.status, body: { error: created.error, code: 'device_limit' } };
    }
    this.onPaired(created.id);
    return { status: 200, body: { token: created.token, deviceId: created.id } };
  }

  /** The token's id and device name when it is a deck-scoped token, else null. */
  async verify(token: string): Promise<{ id: string; name: string } | null> {
    const record = await findPushToken(this.deckRecords(), token);
    return record ? { id: record.id, name: record.name } : null;
  }

  noteSeen(id: string): void {
    this.tokens.noteUsed(id);
  }

  devices(connected: ReadonlySet<string>): VirtualDeckDeviceView[] {
    return this.deckRecords().map((r) => {
      const lastSeenAt = this.tokens.lastUsedAt(r.id);
      return {
        id: r.id,
        name: r.name,
        createdAt: r.createdAt,
        ...(lastSeenAt !== undefined ? { lastSeenAt } : {}),
        connected: connected.has(r.id),
      };
    });
  }

  private deckRecords(): PushTokenRecord[] {
    return this.tokens.records().filter((r) => r.scopes.includes('deck'));
  }
}
