// LAN listener that serves only the relay installer script (OrbStack route, issue #257). A
// separate tjs.serve from the admin WebUI so no admin route sits on a LAN-reachable port; it runs
// only while that route is active.
import { fallbackPorts, isPortInUse } from './web-request-guard.js';
import { RELAY_SCRIPT_PATH, RELAY_SCRIPT_PORT } from './relay-script.js';

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
  /** Read per request: the LAN IP and version are only known after startup. */
  script: () => string | null;
  log?: (level: 'info' | 'warn', message: string) => void;
}

export class RelayScriptServer {
  private server: TjsServeServer | null = null;
  private starting = false;
  private port: number | null = null;

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
        fetch: (req) => this.handle(req),
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

  private handle(req: Request): Response {
    if (req.method !== 'GET' || new URL(req.url).pathname !== RELAY_SCRIPT_PATH) {
      return new Response(null, { status: 404 });
    }
    const body = this.opts.script();
    if (body === null) return new Response('DeckBridge has no LAN address yet\n', { status: 503 });
    return new Response(body, {
      headers: { 'Content-Type': 'text/x-shellscript; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
}
