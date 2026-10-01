// Push-API bearer tokens: generation, hashing and constant-time lookup. Only the
// SHA-256 hex is stored — the secret has 256 bits of entropy, so a fast unsalted hash
// leaves nothing to brute-force.

/** Structurally identical to the wire `PushScope` (web/contract.ts); infra may not import it. */
export type PushScope = 'push';

export interface PushTokenRecord {
  id: string;
  name: string;
  scopes: PushScope[];
  /** SHA-256 hex of the full token. */
  hash: string;
  /** First characters after `dbp_`, to tell tokens apart in the UI. */
  prefix: string;
  createdAt: string;
}

export const PUSH_TOKENS_MAX = 16;
export const PUSH_TOKEN_NAME_MAX = 40;
export const PUSH_TOKEN_PREFIX = 'dbp_';

const HEX64 = /^[0-9a-f]{64}$/;
const PUSH_SCOPES: readonly string[] = ['push'];

export function isPushTokenRecord(v: unknown): v is PushTokenRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    r.id !== '' &&
    typeof r.name === 'string' &&
    typeof r.prefix === 'string' &&
    typeof r.createdAt === 'string' &&
    typeof r.hash === 'string' &&
    HEX64.test(r.hash) &&
    Array.isArray(r.scopes) &&
    r.scopes.length > 0 &&
    r.scopes.every((s) => PUSH_SCOPES.includes(s as string))
  );
}

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export function generatePushToken(): { token: string; prefix: string } {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const body = Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replaceAll('=', '');
  const token = PUSH_TOKEN_PREFIX + body;
  return { token, prefix: token.slice(PUSH_TOKEN_PREFIX.length, PUSH_TOKEN_PREFIX.length + 6) };
}

/** 8 hex characters. */
export function newTokenId(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(4)));
}

export async function hashPushToken(token: string): Promise<string> {
  if ((crypto as { subtle?: unknown }).subtle === undefined)
    throw new Error('WebCrypto (crypto.subtle) is unavailable in this runtime');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return toHex(new Uint8Array(digest));
}

/** XOR-accumulate over the full length; no early return on a mismatch. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Compares against every record so timing does not reveal which one matched. */
export async function findPushToken(
  records: readonly PushTokenRecord[],
  presented: string,
): Promise<PushTokenRecord | undefined> {
  const hash = await hashPushToken(presented);
  let found: PushTokenRecord | undefined;
  for (const r of records) {
    if (timingSafeEqualHex(hash, r.hash)) found = r;
  }
  return found;
}
