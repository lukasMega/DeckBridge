// Transparent TCP relay between an Elgato client and a DeckBridge on another computer.
//
// Uses raw tjs streams, not platform/tcp.ts: that shim has no half-close and no write
// backpressure, and CORA key images are ACK-paced, so each pump awaits its write.
// txiki closes a socket handle only once BOTH stream halves finish, so the session closes
// both native handles itself when the pumps settle.
//
// With `holdMs > 0` a session outlives its upstream: the client socket stays open while
// the relay redials DeckBridge (session logic in relay-session.ts).
import { guardAccept, isDroppedAccept } from '../../platform/accept-guard.js';
import { Session, closeQuietly, msgOf, noop } from './relay-session.js';
import type { RelayPortName, RelaySessionClose } from './relay-session.js';

export type { RelayPortName, RelaySessionClose };

export interface RelayRoute {
  name: RelayPortName;
  listenPort: number;
  targetPort: number;
}

export interface RelayOptions {
  listenHost: string;
  targetHost: string;
  routes: RelayRoute[];
  /** Default 5000. */
  connectTimeoutMs?: number;
  /**
   * How long a session keeps its client open while DeckBridge is unreachable. Default 0:
   * close both sides as soon as either ends.
   */
  holdMs?: number;
  /** Redial delays while holding; the last value repeats. Default 1 s, 2 s, 5 s. */
  redialBackoffMs?: readonly number[];
  onOpen?: (id: number, route: RelayPortName, client: string) => void;
  onClose?: (s: RelaySessionClose) => void;
  /** Upstream ended first, or a dial failed (every failed attempt). The caller dedupes. */
  onUpstreamLost?: (route: RelayPortName, reason: string) => void;
  onHold?: (id: number, route: RelayPortName, reason: string) => void;
  onResume?: (id: number, route: RelayPortName, heldMs: number) => void;
  /** A client reset before its accept ran (txiki getpeername EINVAL). */
  onDroppedAccept?: (route: RelayPortName, error: string) => void;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_REDIAL_BACKOFF_MS: readonly number[] = [1000, 2000, 5000];

interface Listener {
  route: RelayRoute;
  server: TjsTCPServerSocket;
  reader: ReadableStreamDefaultReader<TjsAcceptedTCPSocket> | null;
  loop: Promise<void> | null;
}

export class CoraRelay {
  private readonly opts: RelayOptions;
  private readonly routes: RelayRoute[];
  private readonly listeners: Listener[] = [];
  private readonly sessions = new Set<{ session: Session; done: Promise<void> }>();
  private nextId = 1;
  private stopped = false;

  constructor(opts: RelayOptions) {
    this.opts = opts;
    this.routes = opts.routes.map((r) => ({ ...r }));
  }

  async start(): Promise<void> {
    const results = await Promise.allSettled(this.routes.map((r) => this.bind(r)));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) {
      await this.stop();
      throw failed.reason;
    }
  }

  private async bind(route: RelayRoute): Promise<void> {
    const server = await tjs.listen('tcp', this.opts.listenHost, route.listenPort);
    guardAccept(server, (e) => this.opts.onDroppedAccept?.(route.name, msgOf(e)));
    const listener: Listener = { route, server, reader: null, loop: null };
    this.listeners.push(listener);
    try {
      const info = await server.opened;
      listener.reader = info.readable.getReader();
    } catch (e) {
      this.detach(listener);
      throw e;
    }
    listener.loop = this.acceptLoop(listener.reader, route);
  }

  private detach(l: Listener): void {
    const i = this.listeners.indexOf(l);
    if (i >= 0) this.listeners.splice(i, 1);
    void l.reader?.cancel().catch(noop);
    closeQuietly(l.server);
  }

  /**
   * Moves a route's listen and target port. The new listener binds before the old one
   * closes, and a failed bind throws with the old listener kept. Open sessions stay.
   */
  async setRoutePort(name: RelayPortName, port: number): Promise<void> {
    const route = this.routes.find((r) => r.name === name);
    if (!route) throw new Error(`no relay route ${name}`);
    if (route.listenPort === port) {
      route.targetPort = port;
      return;
    }
    const old = this.listeners.find((l) => l.route === route);
    const next: RelayRoute = { name, listenPort: port, targetPort: port };
    await this.bind(next);
    this.routes[this.routes.indexOf(route)] = next;
    if (!old || this.stopped) return; // stop() closes every listener itself
    this.detach(old);
    if (old.loop) await old.loop;
  }

  private async acceptLoop(
    reader: ReadableStreamDefaultReader<TjsAcceptedTCPSocket>,
    route: RelayRoute,
  ): Promise<void> {
    try {
      for (;;) {
        const { done, value: conn } = await reader.read();
        if (done) break;
        if (isDroppedAccept(conn)) continue;
        void this.adopt(conn, route);
      }
    } catch {
      // accept stream errored: the listener is unusable; stop() still cleans up
    } finally {
      reader.releaseLock();
    }
  }

  private async adopt(conn: TjsAcceptedTCPSocket, route: RelayRoute): Promise<void> {
    let info: TjsTCPOpenedInfo;
    try {
      info = await conn.opened;
    } catch {
      closeQuietly(conn);
      return;
    }
    if (this.stopped) {
      closeQuietly(conn);
      return;
    }
    const opts = this.opts;
    const id = this.nextId++;
    const session = new Session({
      id,
      route: route.name,
      conn,
      client: `${info.remoteAddress}:${info.remotePort}`,
      targetHost: opts.targetHost,
      targetPort: route.targetPort,
      connectTimeoutMs: opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      holdMs: opts.holdMs ?? 0,
      redialBackoffMs: opts.redialBackoffMs?.length
        ? opts.redialBackoffMs
        : DEFAULT_REDIAL_BACKOFF_MS,
      onOpen: opts.onOpen,
      onClose: opts.onClose,
      onUpstreamLost: opts.onUpstreamLost,
      onHold: opts.onHold,
      onResume: opts.onResume,
    });
    const entry = { session, done: Promise.resolve() };
    this.sessions.add(entry);
    entry.done = session
      .run(info)
      .catch(noop)
      .finally(() => {
        this.sessions.delete(entry);
      });
    await entry.done;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const loops: Promise<void>[] = [];
    for (const l of this.listeners) {
      void l.reader?.cancel().catch(noop);
      closeQuietly(l.server);
      if (l.loop) loops.push(l.loop);
    }
    this.listeners.length = 0;
    await Promise.all(loops);
    const pending = [...this.sessions];
    for (const e of pending) e.session.shutdown();
    await Promise.all(pending.map((e) => e.done));
  }

  openSessions(route?: RelayPortName): number {
    let n = 0;
    for (const { session } of this.sessions) if (!route || session.route === route) n++;
    return n;
  }
}
