// /api/push/* (token-authenticated) and the WebUI-only token/channel admin routes.
import { PUSH_BODY_MAX, isPushChannel } from '../../shared/push-text.js';
import { json, noContent, badRequest } from './http.js';
import { get, post, postJson, type Route } from './router.js';
import { authenticatePush, pushError } from './push-auth.js';
import type { PushController } from './push-controller.js';

/** Must not match `/api/push-tokens` or `/api/push-channels`. */
export function isPushApiPath(pathname: string): boolean {
  return pathname === '/api/push' || pathname.startsWith('/api/push/');
}

const badChannel = (): { response: Response } => ({
  response: pushError(400, 'invalid_channel', 'channel must be 1–32 of a-z 0-9 . _ -'),
});

function channelOf(url: URL): { channel: string } | { response: Response } {
  const segments = url.pathname.split('/').filter(Boolean); // api, push, :channel
  if (segments.length !== 3) {
    return { response: pushError(404, 'not_found', 'use /api/push/<channel>') };
  }
  let channel: string;
  try {
    channel = decodeURIComponent(segments[2]!).toLowerCase();
  } catch {
    return badChannel();
  }
  return isPushChannel(channel) ? { channel } : badChannel();
}

const isJsonType = (ct: string | null): boolean =>
  ct !== null && /^application\/json\s*(?:;|$)/i.test(ct);

const tooLarge = (): { response: Response } => ({
  response: pushError(413, 'payload_too_large', `body exceeds ${PUSH_BODY_MAX} bytes`),
});

async function readBody(req: Request): Promise<{ body: unknown } | { response: Response }> {
  const declared = Number(req.headers.get('Content-Length') ?? 0);
  if (declared > PUSH_BODY_MAX) return tooLarge();
  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > PUSH_BODY_MAX) return tooLarge();
  try {
    return { body: JSON.parse(raw) as unknown };
  } catch {
    return { response: pushError(400, 'invalid_json', 'body is not valid JSON') };
  }
}

export async function handlePushApi(
  push: PushController,
  req: Request,
  url: URL,
  remote: string,
  port: number,
): Promise<Response> {
  const parsedChannel = channelOf(url);
  if ('response' in parsedChannel) return parsedChannel.response;
  const { channel } = parsedChannel;
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    return pushError(405, 'method_not_allowed', 'use POST or DELETE', { Allow: 'POST, DELETE' });
  }
  const auth = await authenticatePush(req, port, remote, push.records(), push.limits);
  if (!auth.ok) return auth.response;
  const wait = push.limits.takePush(auth.tokenId);
  if (wait > 0) {
    return pushError(429, 'rate_limited', 'rate limit exceeded', { 'Retry-After': String(wait) });
  }
  if (req.method === 'DELETE') {
    push.clear(channel);
    push.noteUsed(auth.tokenId);
    return noContent();
  }
  if (!isJsonType(req.headers.get('Content-Type'))) {
    return pushError(415, 'unsupported_media_type', 'Content-Type must be application/json');
  }
  const parsed = await readBody(req);
  if ('response' in parsed) return parsed.response;
  const result = push.push(channel, parsed.body);
  if (!('ok' in result)) return pushError(result.status, result.code, result.error);
  push.noteUsed(auth.tokenId);
  return json(result);
}

interface TokenNameBody {
  name?: unknown;
}

const tokenResult = (r: { error: string; status: number } | object): Response =>
  'error' in r ? json({ error: r.error }, (r as { status: number }).status) : json(r, 201);

/** Browser-guarded like every admin route; no token. */
export const pushAdminRoutes: Route[] = [
  get('/api/push-tokens', ({ push }) => json({ tokens: push.tokens() })),
  postJson<TokenNameBody>('/api/push-tokens', async (body, { push }) =>
    tokenResult(await push.createToken(body.name)),
  ),
  post('/api/push-tokens/:id/rotate', async ({ push, params }) => {
    const r = await push.rotateToken(params.id!);
    return 'error' in r ? json({ error: r.error }, r.status) : json(r);
  }),
  post('/api/push-tokens/:id/revoke', ({ push, params }) => {
    const err = push.revokeToken(params.id!);
    return err ? json({ error: err.error }, err.status) : json({ ok: true });
  }),
  get('/api/push-channels', ({ push }) => json({ channels: push.channels() })),
  postJson<unknown>('/api/push-channels/:channel', (body, { push, params }) => {
    const channel = params.channel!.toLowerCase();
    if (!isPushChannel(channel)) return badRequest('invalid channel');
    const r = push.push(channel, body);
    return 'ok' in r ? json(r) : json({ error: r.error, code: r.code }, r.status);
  }),
  post('/api/push-channels/:channel/clear', ({ push, params }) => {
    push.clear(params.channel!.toLowerCase());
    return json({ ok: true });
  }),
];
