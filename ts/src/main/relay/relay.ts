// Transparent TCP relay between an Elgato client and a DeckBridge on another computer.
//
// Uses raw tjs streams, not platform/tcp.ts: that shim has no half-close and no write
// backpressure, and CORA image chunks are ACK-paced, so each pump awaits its write.
// txiki closes a socket handle only once BOTH stream halves finish, so the session closes
// both native handles itself when the pumps settle.
import { guardAccept, isDroppedAccept } from '../../platform/accept-guard.js';

export type RelayPortName = 'main' | 'child';

export interface RelayRoute {
  name: RelayPortName;
  listenPort: number;
  targetPort: number;
}

export interface RelaySessionClose {
  id: number;
  route: RelayPortName;
  /** 'addr:port' of the Elgato client. */
  client: string;
  durationMs: number;
  /** Elgato -> DeckBridge. */
  bytesUp: number;
  /** DeckBridge -> Elgato. */
  bytesDown: number;
  /** First side to finish. */
  closedBy: 'E' | 'D' | 'relay';
  /** 'FIN' | 'error <msg>' | 'connect failed <msg>' | 'connect timeout' | 'shutdown' */
  how: string;
}

export interface RelayOptions {
  listenHost: string;
  targetHost: string;
  routes: RelayRoute[];
  /** Default 5000. */
  connectTimeoutMs?: number;
  onOpen?: (id: number, route: RelayPortName, client: string) => void;
  onClose?: (s: RelaySessionClose) => void;
  /** A client reset before its accept ran (txiki getpeername EINVAL). */
  onDroppedAccept?: (route: RelayPortName, error: string) => void;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

type Side = 'E' | 'D';

const noop = (): void => {};

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function closeQuietly(native: { close(): void } | null): void {
  try {
    native?.close();
  } catch {
    // already closed
  }
}

interface SessionDeps {
  id: number;
  route: RelayPortName;
  conn: TjsAcceptedTCPSocket;
  client: string;
  targetHost: string;
  targetPort: number;
  connectTimeoutMs: number;
  onOpen: RelayOptions['onOpen'];
  onClose: RelayOptions['onClose'];
}

class Session {
  readonly route: RelayPortName;
  private readonly d: SessionDeps;
  private readonly startedAt = Date.now();
  private closedBy: RelaySessionClose['closedBy'] | null = null;
  private how = '';
  private bytesUp = 0;
  private bytesDown = 0;
  private upstream: TjsTCPSocket | null = null;
  private connectAbort: AbortController | null = null;
  private readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  private writers: WritableStreamDefaultWriter<Uint8Array>[] = [];
  private torn = false;

  constructor(d: SessionDeps) {
    this.d = d;
    this.route = d.route;
  }

  /** The first call wins; later ones are consequences of it. */
  private finish(by: RelaySessionClose['closedBy'], how: string): void {
    if (this.closedBy !== null) return;
    this.closedBy = by;
    this.how = how;
  }

  private teardown(): void {
    if (this.torn) return;
    this.torn = true;
    this.connectAbort?.abort();
    this.connectAbort = null;
    for (const r of this.readers) void r.cancel().catch(noop);
    for (const w of this.writers) void w.abort().catch(noop);
    closeQuietly(this.d.conn);
    closeQuietly(this.upstream);
  }

  private get finished(): boolean {
    return this.closedBy !== null;
  }

  shutdown(): void {
    this.finish('relay', 'shutdown');
    this.teardown();
  }

  private report(): void {
    const d = this.d;
    try {
      d.onClose?.({
        id: d.id,
        route: d.route,
        client: d.client,
        durationMs: Date.now() - this.startedAt,
        bytesUp: this.bytesUp,
        bytesDown: this.bytesDown,
        closedBy: this.closedBy ?? 'relay',
        how: this.how || 'shutdown',
      });
    } catch {
      // a throwing callback must not leave the session half-released
    }
  }

  async run(clientInfo: TjsTCPOpenedInfo): Promise<void> {
    const d = this.d;
    try {
      d.onOpen?.(d.id, d.route, d.client);
    } catch {
      // see report()
    }
    const upInfo = await this.dialUpstream();
    if (upInfo === null || this.finished) {
      this.teardown();
      this.report();
      return;
    }
    const cr = clientInfo.readable.getReader();
    const cw = clientInfo.writable.getWriter();
    const ur = upInfo.readable.getReader();
    const uw = upInfo.writable.getWriter();
    this.readers = [cr, ur];
    this.writers = [cw, uw];
    await Promise.all([this.pump(cr, uw, 'E', 'D'), this.pump(ur, cw, 'D', 'E')]);
    this.teardown();
    this.report();
  }

  /** Null when the dial failed; the failure is already recorded. */
  private async dialUpstream(): Promise<TjsTCPOpenedInfo | null> {
    const d = this.d;
    const abort = new AbortController();
    this.connectAbort = abort;
    const timer = setTimeout(function onConnectTimeout() {
      abort.abort(new Error('timeout'));
    }, d.connectTimeoutMs);
    try {
      const sock = await tjs.connect('tcp', d.targetHost, d.targetPort, { signal: abort.signal });
      this.upstream = sock;
      return await sock.opened;
    } catch (e) {
      this.finish('relay', abort.signal.aborted ? 'connect timeout' : `connect failed ${msgOf(e)}`);
      return null;
    } finally {
      clearTimeout(timer);
      this.connectAbort = null;
    }
  }

  private async pump(
    from: ReadableStreamDefaultReader<Uint8Array>,
    to: WritableStreamDefaultWriter<Uint8Array>,
    fromSide: Side,
    toSide: Side,
  ): Promise<void> {
    let stage: 'read' | 'write' | 'close' = 'read';
    try {
      for (;;) {
        stage = 'read';
        const { done, value } = await from.read();
        if (done) break;
        stage = 'write';
        await to.write(value);
        if (fromSide === 'E') this.bytesUp += value.byteLength;
        else this.bytesDown += value.byteLength;
      }
      this.finish(fromSide, 'FIN');
      stage = 'close';
      await to.close(); // half-close: the other side gets its FIN
    } catch (e) {
      this.finish(stage === 'read' ? fromSide : toSide, `error ${msgOf(e)}`);
      this.teardown();
    }
  }
}

interface Listener {
  server: TjsTCPServerSocket;
  reader: ReadableStreamDefaultReader<TjsAcceptedTCPSocket> | null;
  loop: Promise<void> | null;
}

export class CoraRelay {
  private readonly opts: RelayOptions;
  private readonly listeners: Listener[] = [];
  private readonly sessions = new Set<{ session: Session; done: Promise<void> }>();
  private nextId = 1;
  private stopped = false;

  constructor(opts: RelayOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    const results = await Promise.allSettled(this.opts.routes.map((r) => this.bind(r)));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) {
      await this.stop();
      throw failed.reason;
    }
  }

  private async bind(route: RelayRoute): Promise<void> {
    const server = await tjs.listen('tcp', this.opts.listenHost, route.listenPort);
    guardAccept(server, (e) => this.opts.onDroppedAccept?.(route.name, msgOf(e)));
    const listener: Listener = { server, reader: null, loop: null };
    this.listeners.push(listener);
    const info = await server.opened;
    listener.reader = info.readable.getReader();
    listener.loop = this.acceptLoop(listener.reader, route);
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
      onOpen: opts.onOpen,
      onClose: opts.onClose,
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
