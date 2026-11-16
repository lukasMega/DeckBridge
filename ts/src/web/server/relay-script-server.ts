// LAN listener for the relay install scripts (OrbStack and other-device routes, issue #257): it
// serves the script and takes the script's progress events. A separate tjs.serve from the admin
// WebUI so no admin route sits on a LAN-reachable port; it runs only while such a route is active.
import { fallbackPorts, isPortInUse } from './web-request-guard.js';
import { RELAY_SCRIPT_PATH, RELAY_SCRIPT_PORT } from './relay-script.js';
import { RELAY_EVENT_PATH } from './relay-script-device.js';
import { lanPeer, parseRelayEvent, RateLimit, tokenMatches } from './relay-script-guard.js';
import type { RelayEventBody } from '../contract-pairing-route.js';

const MAX_BODY_BYTES = 1024;
const EVENTS_PER_MINUTE = 30;

/** `preferred` if free, else the first free fallback port; else `preferred` anyway so tjs.serve
 *  reports the real bind error. */
async function resolveListenPort(preferred: number): Promise<number> {
  if (!(await isPortInUse(preferred))) return preferred;
  for (const port of fallbackPorts()) {
    if (port !== preferred && !(await isPortInUse(port))) return port;
  }
  return preferred;
}

export interface RelayScriptServerOptions {
  listenIp: string;
  /** The live script token; null while no script route is selected (everything then 404s). */
  token: () => string | null;
  /** Read per request: the LAN IP and version are only known after startup. */
  script: (ctx: { token: string; port: number }) => string | null;
  /** `ip` is the socket peer, not a body field. */
  onEvent: (ev: Omit<RelayEventBody, 't'>, ip: string) => void;
  now?: () => number;
  log?: (level: 'info' | 'warn', message: string) => void;
}

export class RelayScriptServer {
  private server: TjsServeServer | null = null;
  private starting = false;
  private port: number | null = null;
  private readonly limit = new RateLimit(EVENTS_PER_MINUTE, 60_000);

  constructor(private readonly opts: RelayScriptServerOptions) {}

  get listening(): boolean {
    return this.server !== null;
  }

  /** The port the script is (or will be) served on. The wizard probes before the route starts
   *  the server, so the port is chosen here and kept for the process: a copied command stays
   *  valid across route toggles. Falls back to a free high port when RELAY_SCRIPT_PORT is taken. */
  async reservePort(): Promise<number> {
    this.port ??= await resolveListenPort(RELAY_SCRIPT_PORT);
    return this.port;
  }

  /** A bind failure is logged, not thrown. */
  async start(): Promise<void> {
    if (this.server !== null || this.starting) return;
    this.starting = true;
    try {
      let port = await this.reservePort();
      // Taken since it was reserved (rare): pick again; an open wizard shows the new port on reopen.
      if (await isPortInUse(port)) {
        this.port = null;
        port = await this.reservePort();
        this.opts.log?.('warn', `relay script port changed to ${port}`);
      }
      this.server = tjs.serve({
        port,
        listenIp: this.opts.listenIp,
        fetch: (req, extra) => this.handle(req, extra.remoteAddress),
      });
      if (port !== RELAY_SCRIPT_PORT) {
        this.opts.log?.(
          'info',
          `relay script port ${RELAY_SCRIPT_PORT} in use; serving on ${port}`,
        );
      }
    } catch (e) {
      this.opts.log?.('warn', `relay script server: ${(e as Error).message}`);
    } finally {
      this.starting = false;
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    await server?.close();
  }

  private async handle(req: Request, remote: string): Promise<Response> {
    const url = new URL(req.url);
    const token = this.opts.token();
    if (token === null) return new Response(null, { status: 404 });
    if (req.method === 'GET' && url.pathname === RELAY_SCRIPT_PATH) {
      return this.serveScript(token, url.searchParams.get('t'));
    }
    if (req.method === 'POST' && url.pathname === RELAY_EVENT_PATH) {
      return this.takeEvent(req, token, remote);
    }
    return new Response(null, { status: 404 });
  }

  private serveScript(token: string, given: string | null): Response {
    // 404, not 403: an unauthorised probe learns nothing about the route.
    if (!tokenMatches(given, token)) return new Response(null, { status: 404 });
    const body = this.opts.script({ token, port: this.port ?? RELAY_SCRIPT_PORT });
    if (body === null) return new Response('DeckBridge has no LAN address yet\n', { status: 503 });
    return new Response(body, {
      headers: { 'Content-Type': 'text/x-shellscript; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  private async takeEvent(req: Request, token: string, remote: string): Promise<Response> {
    const ip = lanPeer(remote);
    if (ip === null) return new Response(null, { status: 403 });
    const declared = Number(req.headers.get('content-length') ?? 0);
    if (declared > MAX_BODY_BYTES) return new Response(null, { status: 400 });
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return new Response(null, { status: 400 });
    const ev = parseRelayEvent(text);
    if (ev === null) return new Response(null, { status: 400 });
    if (!tokenMatches(ev.t, token)) return new Response(null, { status: 403 });
    // After the token check, so a flood of bad tokens can't use up a real relay's budget.
    if (!this.limit.allow((this.opts.now ?? Date.now)()))
      return new Response(null, { status: 429 });
    const { stage, platform, version, message } = ev;
    this.opts.onEvent(
      { stage, platform, version, ...(message === undefined ? {} : { message }) },
      ip,
    );
    return new Response(null, { status: 204 });
  }
}
