// One pending pairing at a time: a long code for the QR and a 6-digit code for typing.
import { timingSafeEqualHex } from '../../../infra/push-tokens.js';
import { PAIRING_MAX_FAILS, PAIRING_TTL_MS } from './deck-constants.js';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const SHORT_CODE_SPACE = 1_000_000;
// Reject the top sliver of the 32-bit range so `% 1e6` has no modulo bias.
const SHORT_CODE_LIMIT = Math.floor(0x1_0000_0000 / SHORT_CODE_SPACE) * SHORT_CODE_SPACE;

export interface PendingPairing {
  code: string;
  shortCode: string;
  expiresAt: number;
}

export type ConsumeResult = 'ok' | 'invalid' | 'expired' | 'none';

function randomBase32(bytes: number): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const b of raw) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32.charAt((acc >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  return out;
}

function randomShortCode(): string {
  const word = new Uint32Array(1);
  do crypto.getRandomValues(word);
  while (word[0]! >= SHORT_CODE_LIMIT);
  return String(word[0]! % SHORT_CODE_SPACE).padStart(6, '0');
}

export class PairingCodes {
  private current: PendingPairing | null = null;
  private fails = 0;

  /** Replaces any pending pairing. */
  create(now: number): PendingPairing {
    this.current = {
      code: randomBase32(20),
      shortCode: randomShortCode(),
      expiresAt: now + PAIRING_TTL_MS,
    };
    this.fails = 0;
    return this.current;
  }

  consume(input: { code?: string; shortCode?: string }, now: number): ConsumeResult {
    const cur = this.current;
    if (!cur) return 'none';
    if (now > cur.expiresAt) {
      this.current = null;
      return 'expired';
    }
    const ok =
      (typeof input.code === 'string' && timingSafeEqualHex(input.code, cur.code)) ||
      (typeof input.shortCode === 'string' && timingSafeEqualHex(input.shortCode, cur.shortCode));
    if (ok) {
      this.current = null;
      return 'ok';
    }
    if (++this.fails >= PAIRING_MAX_FAILS) this.current = null;
    return 'invalid';
  }

  cancel(): void {
    this.current = null;
  }

  pending(now: number): PendingPairing | null {
    if (this.current && now > this.current.expiresAt) this.current = null;
    return this.current;
  }
}
