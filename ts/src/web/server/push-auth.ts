// Authentication for /api/push/*: Origin, failed-auth throttle, bearer token, scope.
// Deliberately no Host check — a valid token is proof enough, and it lets LAN clients use
// `name.local` (see docs/push-api.md).
import { findPushToken, type PushTokenRecord } from '../../infra/push-tokens.js';
import type { PushErrorCode } from '../contract.js';
import { isAllowedOrigin } from './web-request-guard.js';
import type { PushRateLimits } from './push-rate-limit.js';

export type PushAuthResult = { ok: true; tokenId: string } | { ok: false; response: Response };

export function pushError(
  status: number,
  code: PushErrorCode,
  error: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ error, code }), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const fail = (response: Response): PushAuthResult => ({ ok: false, response });

const BEARER = /^bearer\s+(\S+)$/i;

const NO_TOKEN_HINT = 'missing or invalid token — create one in the WebUI: Settings → Push API';

export async function authenticatePush(
  req: Request,
  port: number,
  remote: string,
  records: readonly PushTokenRecord[],
  limits: PushRateLimits,
): Promise<PushAuthResult> {
  const origin = req.headers.get('Origin');
  if (origin !== null && !isAllowedOrigin(origin, port)) {
    return fail(pushError(403, 'forbidden_origin', 'browser requests are not allowed'));
  }
  const wait = limits.checkFailedAuth(remote);
  if (wait > 0) {
    return fail(
      pushError(429, 'rate_limited', 'too many failed attempts', { 'Retry-After': String(wait) }),
    );
  }
  const unauthorized = (): PushAuthResult => {
    limits.noteFailedAuth(remote);
    return fail(pushError(401, 'unauthorized', NO_TOKEN_HINT, { 'WWW-Authenticate': 'Bearer' }));
  };
  const match = BEARER.exec(req.headers.get('Authorization') ?? '');
  if (!match) return unauthorized();
  const record = await findPushToken(records, match[1]!);
  if (!record) return unauthorized();
  if (!record.scopes.includes('push')) {
    return fail(pushError(403, 'insufficient_scope', 'token lacks the push scope'));
  }
  return { ok: true, tokenId: record.id };
}
