// Strict parsing of client → server deck messages; anything off-shape is a protocol error.
import type { DeckClientMsg } from '../../contract-deck.js';
import { DECK_MAX_TEXT_BYTES } from './deck-constants.js';

const CLIENT_ID_MAX = 64;
const NAME_MAX = 80;

type Raw = Record<string, unknown>;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isShortString = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length <= max;

function parseHello(m: Raw): DeckClientMsg | null {
  const { v, token, clientId, now, name } = m;
  if (!isCount(v) || typeof token !== 'string' || !isNum(now)) return null;
  if (!isShortString(clientId, CLIENT_ID_MAX) || clientId.length === 0) return null;
  if (name !== undefined && !isShortString(name, NAME_MAX)) return null;
  return { t: 'hello', v, token, clientId, now, ...(name !== undefined ? { name } : {}) };
}

function parseKey(m: Raw): DeckClientMsg | null {
  const { k, s, now } = m;
  if (!isCount(k) || (s !== 'down' && s !== 'up') || !isNum(now)) return null;
  return { t: 'key', k, s, now };
}

export function parseDeckClientMsg(text: string): DeckClientMsg | null {
  if (text.length > DECK_MAX_TEXT_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Raw;
  switch (m.t) {
    case 'hello':
      return parseHello(m);
    case 'key':
      return parseKey(m);
    case 'releaseAll':
    case 'ping':
      return isNum(m.now) ? { t: m.t, now: m.now } : null;
    case 'ack':
      return isCount(m.n) ? { t: 'ack', n: m.n } : null;
    default:
      return null;
  }
}
