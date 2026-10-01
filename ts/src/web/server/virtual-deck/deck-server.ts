// The deck-only HTTP/WS listener. A separate tjs.serve from the admin WebUI so that no
// admin route exists on a LAN-reachable port: this one serves the page, pairing and /deck/ws.
import type { DeckPairRequest } from '../../contract-deck.js';
import { isAllowedWebRequest, isPortInUse } from '../web-request-guard.js';
import type { DeckAuth } from './deck-auth.js';
import { deckAssets, deckManifest } from './deck-assets.js';
import { DECK_MAX_TEXT_BYTES, DECK_TICK_MS } from './deck-constants.js';
import type { DeckHub } from './deck-hub.js';

export interface DeckServerOptions {
  port: number;
  listenIp: string;
  hub: DeckHub;
  auth: DeckAuth;
  log?: (level: 'debug' | 'info' | 'warn', message: string) => void;
}

// No connect-src: Safari 12 does not match `ws:` against 'self'.
const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
};

function reply(
  body: BodyInit | null,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers: { ...SECURITY_HEADERS, ...headers } });
}

const jsonReply = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  reply(JSON.stringify(data), status, { 'Content-Type': 'application/json', ...headers });

const STATIC: Record<string, () => Response> = {
  '/deck': () => page(),
  '/deck/': () => page(),
  '/deck/deck.js': () =>
    reply(deckAssets.js, 200, {
      'Content-Type': 'application/javascript',
      'Cache-Control': 'no-cache',
    }),
  '/deck/deck.css': () =>
    reply(deckAssets.css, 200, { 'Content-Type': 'text/css', 'Cache-Control': 'no-cache' }),
  '/deck/manifest.webmanifest': () =>
    reply(deckManifest(), 200, { 'Content-Type': 'application/manifest+json' }),
  '/deck/icon-180.png': () => icon(180),
  '/deck/icon-512.png': () => icon(512),
};

function page(): Response {
  return reply(deckAssets.html, 200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
}

function icon(size: 180 | 512): Response {
  return reply(deckAssets.icon(size), 200, {
    'Content-Type': 'image/png',
    'Cache-Control': 'max-age=86400',
  });
}

export class DeckServer {
  private server: TjsServeServer | null = null;
  private tick: ReturnType<typeof setInterval> | undefined;
  lastError: string | undefined;

  constructor(private readonly opts: DeckServerOptions) {}

  get listening(): boolean {
    return this.server !== null;
  }

  get port(): number {
    return this.opts.port;
  }

  /** One attempt, no port fallback: a paired page bookmarks this URL. Throws on a bind error.
   *  tjs.serve reports a taken port late and not as a throw, hence the probe first. */
  async start(): Promise<void> {
    const { hub } = this.opts;
    if (await isPortInUse(this.opts.port)) {
      this.lastError = `port ${this.opts.port} is already in use`;
      throw new Error(this.lastError);
    }
    try {
      this.server = tjs.serve({
        port: this.opts.port,
        listenIp: this.opts.listenIp,
        fetch: (req, extra) => this.handle(req, extra),
        websocket: {
          open: (ws) => hub.open(ws, remoteOf(ws)),
          message: (ws, data) => hub.message(ws, data),
          close: (ws) => hub.close(ws),
          error: (ws) => hub.close(ws),
        },
      });
    } catch (e) {
      this.lastError = (e as Error).message;
      throw e;
    }
    this.lastError = undefined;
    this.tick = setInterval(() => hub.tick(), DECK_TICK_MS);
  }

  async stop(): Promise<void> {
    clearInterval(this.tick);
    this.tick = undefined;
    const server = this.server;
    this.server = null;
    await server?.close();
  }

  private handle(
    req: Request,
    extra: { server: TjsServeServer; remoteAddress: string },
  ): Response | Promise<Response> | void {
    try {
      return this.route(req, extra);
    } catch {
      return reply('Bad Request', 400); // e.g. a Host header that is not a valid authority
    }
  }

  private route(
    req: Request,
    extra: { server: TjsServeServer; remoteAddress: string },
  ): Response | Promise<Response> | void {
    const url = new URL(req.url);
    if (!isAllowedWebRequest(req.headers.get('Host'), req.headers.get('Origin'), this.opts.port)) {
      return reply('Forbidden', 403);
    }
    const remote = extra.remoteAddress || 'unknown';
    if (url.pathname === '/deck/ws' && req.headers.get('Upgrade') === 'websocket') {
      extra.server.upgrade(req, { data: { remoteAddress: remote } });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/deck/api/pair') return this.pair(req, remote);
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (url.pathname === '/') return reply(null, 302, { Location: '/deck/' });
      const serve = STATIC[url.pathname];
      if (serve) return serve();
    }
    return reply(null, 404);
  }

  private async pair(req: Request, remote: string): Promise<Response> {
    const raw = await req.text();
    if (raw.length > DECK_MAX_TEXT_BYTES) return jsonReply({ error: 'body too large' }, 413);
    let body: DeckPairRequest;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
      body = parsed;
    } catch {
      return jsonReply({ error: 'invalid JSON', code: 'invalid_json' }, 400);
    }
    const result = await this.opts.auth.pair(
      {
        ...(typeof body.code === 'string' ? { code: body.code } : {}),
        ...(typeof body.shortCode === 'string' ? { shortCode: body.shortCode } : {}),
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
      },
      remote,
    );
    const headers: Record<string, string> = result.retryAfter
      ? { 'Retry-After': String(result.retryAfter) }
      : {};
    this.opts.log?.('info', `pair from ${remote}: ${result.status}`);
    return jsonReply(result.body, result.status, headers);
  }
}

function remoteOf(ws: ServerWebSocket): string {
  return (ws.data as { remoteAddress?: string } | undefined)?.remoteAddress ?? 'unknown';
}
