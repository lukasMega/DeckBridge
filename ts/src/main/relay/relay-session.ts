// One relayed client connection. Design notes (raw tjs streams, awaited writes,
// closing both native handles) are in relay.ts.

import { KEEPALIVE_DELAY_S } from '../../platform/accept-guard.js';

export type RelayPortName = 'main' | 'child';

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
  /**
   * 'FIN' | 'error <msg>' | 'connect failed <msg>' | 'connect timeout' | 'shutdown' |
   * 'hold expired' | 'hold buffer full'
   */
  how: string;
}

export interface SessionDeps {
  id: number;
  route: RelayPortName;
  conn: TjsAcceptedTCPSocket;
  client: string;
  targetHost: string;
  targetPort: number;
  connectTimeoutMs: number;
  /** 0 = close both sides as soon as either ends. */
  holdMs: number;
  redialBackoffMs: readonly number[];
  onOpen?: (id: number, route: RelayPortName, client: string) => void;
  onClose?: (s: RelaySessionClose) => void;
  onUpstreamLost?: (route: RelayPortName, reason: string) => void;
  onHold?: (id: number, route: RelayPortName, reason: string) => void;
  onResume?: (id: number, route: RelayPortName, heldMs: number) => void;
}

/** Client bytes kept while upstream is away; more than this ends the session. */
const HOLD_BUFFER_CAP = 64 * 1024;

type Side = 'E' | 'D';
type Reader = ReadableStreamDefaultReader<Uint8Array>;
type Writer = WritableStreamDefaultWriter<Uint8Array>;

export const noop = (): void => {};

export function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function closeQuietly(native: { close(): void } | null): void {
  try {
    native?.close();
  } catch {
    // already closed
  }
}

/** A throwing callback must not leave the session half-released. */
function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // see above
  }
}

export class Session {
  readonly route: RelayPortName;
  private readonly d: SessionDeps;
  private readonly startedAt = Date.now();
  private closedBy: RelaySessionClose['closedBy'] | null = null;
  private how = '';
  private bytesUp = 0;
  private bytesDown = 0;
  private upstream: TjsTCPSocket | null = null;
  private connectAbort: AbortController | null = null;
  private readers: Reader[] = [];
  private writers: Writer[] = [];
  private torn = false;
  // Hold mode only: the current upstream's streams, whether client bytes may go straight to
  // it, the bytes parked while it is away, and the hook that cuts a backoff sleep short.
  private ur: Reader | null = null;
  private uw: Writer | null = null;
  private live = false;
  private upReason: string | null = null;
  private buf: Uint8Array[] = [];
  private bufBytes = 0;
  private wake: (() => void) | null = null;
  // Start of the current outage (the accept time when the first dial failed).
  private heldSince: number | null = null;
  private everLive = false;
  private attempt = 0;

  constructor(d: SessionDeps) {
    this.d = d;
    this.route = d.route;
  }

  /** The first call wins; later ones are consequences of it. */
  private finish(by: RelaySessionClose['closedBy'], how: string): void {
    if (this.closedBy !== null) return;
    this.closedBy = by;
    this.how = how;
    this.wake?.();
  }

  private teardown(): void {
    if (this.torn) return;
    this.torn = true;
    this.connectAbort?.abort();
    this.connectAbort = null;
    for (const r of this.readers) void r.cancel().catch(noop);
    for (const w of this.writers) void w.abort().catch(noop);
    closeQuietly(this.d.conn);
    this.dropUpstream();
  }

  // A method, not a getter: TS would narrow `this.isFinished()` across awaits.
  private isFinished(): boolean {
    return this.closedBy !== null;
  }

  shutdown(): void {
    this.finish('relay', 'shutdown');
    this.teardown();
  }

  private report(): void {
    const d = this.d;
    safely(() => {
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
    });
  }

  private lost(reason: string): void {
    safely(() => this.d.onUpstreamLost?.(this.d.route, reason));
  }

  async run(clientInfo: TjsTCPOpenedInfo): Promise<void> {
    const d = this.d;
    safely(() => d.onOpen?.(d.id, d.route, d.client));
    if (d.holdMs > 0) {
      await this.runHeld(clientInfo);
      return;
    }
    const dialed = await this.dial(d.connectTimeoutMs);
    if (typeof dialed === 'string') {
      const first = !this.isFinished();
      this.finish('relay', dialed);
      if (first) this.lost(dialed);
    }
    if (typeof dialed === 'string' || this.isFinished()) {
      this.teardown();
      this.report();
      return;
    }
    const cr = clientInfo.readable.getReader();
    const cw = clientInfo.writable.getWriter();
    const ur = dialed.readable.getReader();
    const uw = dialed.writable.getWriter();
    this.readers = [cr, ur];
    this.writers = [cw, uw];
    await Promise.all([this.pump(cr, uw, 'E', 'D'), this.pump(ur, cw, 'D', 'E')]);
    this.teardown();
    this.report();
  }

  /** A string is the failure reason; nothing is recorded here. */
  private async dial(timeoutMs: number): Promise<TjsTCPOpenedInfo | string> {
    const d = this.d;
    const abort = new AbortController();
    this.connectAbort = abort;
    const timer = setTimeout(function onConnectTimeout() {
      abort.abort(new Error('timeout'));
    }, timeoutMs);
    try {
      // noDelay: Nagle would add its delayed-ACK wait to every small ACK and key event.
      // keepAliveDelay: seconds (libuv), so a vanished upstream is noticed while idle.
      const sock = await tjs.connect('tcp', d.targetHost, d.targetPort, {
        signal: abort.signal,
        noDelay: true,
        keepAliveDelay: KEEPALIVE_DELAY_S,
      });
      this.upstream = sock;
      return await sock.opened;
    } catch (e) {
      return abort.signal.aborted ? 'connect timeout' : `connect failed ${msgOf(e)}`;
    } finally {
      clearTimeout(timer);
      this.connectAbort = null;
    }
  }

  private async pump(from: Reader, to: Writer, fromSide: Side, toSide: Side): Promise<void> {
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
      this.markEnd(fromSide, 'FIN');
      stage = 'close';
      await to.close(); // half-close: the other side gets its FIN
    } catch (e) {
      this.markEnd(stage === 'read' ? fromSide : toSide, `error ${msgOf(e)}`);
      this.teardown();
    }
  }

  /** Records the first end; tells the owner when it was the upstream. */
  private markEnd(by: Side, how: string): void {
    const first = !this.isFinished();
    this.finish(by, how);
    if (first && by === 'D') this.lost(how);
  }

  // ---- hold mode (holdMs > 0) ----

  private async runHeld(clientInfo: TjsTCPOpenedInfo): Promise<void> {
    const cr = clientInfo.readable.getReader();
    const cw = clientInfo.writable.getWriter();
    this.readers = [cr];
    this.writers = [cw];
    const clientPump = this.pumpClient(cr);
    await this.holdLoop(cw);
    this.teardown();
    await clientPump.catch(noop);
    this.report();
  }

  /** Dial, pump, and on every upstream loss redial until the hold window closes. */
  private async holdLoop(cw: Writer): Promise<void> {
    for (;;) {
      const reason = await this.connectAndPump(cw);
      if (reason === null) return;
      this.lost(reason);
      if (this.heldSince === null) {
        const since = this.everLive ? Date.now() : this.startedAt;
        this.heldSince = since;
        safely(() => this.d.onHold?.(this.d.id, this.d.route, reason));
      }
      if (!(await this.backoff(this.heldSince + this.d.holdMs))) return;
    }
  }

  /** Why the upstream ended or could not be reached; null when the session is over. */
  private async connectAndPump(cw: Writer): Promise<string | null> {
    const d = this.d;
    const windowEnd = (this.heldSince ?? this.startedAt) + d.holdMs;
    const dialed = await this.dial(
      Math.min(d.connectTimeoutMs, Math.max(1, windowEnd - Date.now())),
    );
    if (this.isFinished()) return null;
    const ur = typeof dialed === 'string' ? null : await this.attach(dialed);
    let reason: string;
    if (ur === null) {
      reason = typeof dialed === 'string' ? dialed : (this.upReason ?? 'error');
    } else {
      this.everLive = true;
      this.markResumed();
      reason = await this.pumpUp(ur, cw);
    }
    this.dropUpstream();
    return this.isFinished() ? null : reason;
  }

  private markResumed(): void {
    const since = this.heldSince;
    this.attempt = 0;
    if (since === null) return;
    this.heldSince = null;
    const d = this.d;
    safely(() => d.onResume?.(d.id, d.route, Date.now() - since));
  }

  /** Sleeps one redial step; false when the session ended or the window closed. */
  private async backoff(end: number): Promise<boolean> {
    const d = this.d;
    const left = end - Date.now();
    if (left > 0) {
      const step =
        d.redialBackoffMs[Math.min(this.attempt++, d.redialBackoffMs.length - 1)] ?? 1000;
      await this.sleep(Math.min(step, left));
    }
    if (this.isFinished()) return false;
    if (Date.now() < end) return true;
    this.finish('relay', 'hold expired');
    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }

  /** The new upstream's reader, or null when parked client bytes could not be sent. */
  private async attach(info: TjsTCPOpenedInfo): Promise<Reader | null> {
    const ur = info.readable.getReader();
    const uw = info.writable.getWriter();
    this.ur = ur;
    this.uw = uw;
    this.upReason = null;
    return (await this.flush(uw)) ? ur : null;
  }

  /** Parked bytes first, so order holds; `live` flips only once the buffer is empty. */
  private async flush(uw: Writer): Promise<boolean> {
    try {
      while (this.buf.length > 0) {
        const chunk = this.buf[0];
        if (!chunk) break;
        await uw.write(chunk);
        this.buf.shift();
        this.bufBytes -= chunk.byteLength;
        this.bytesUp += chunk.byteLength;
      }
    } catch (e) {
      this.upReason = `error ${msgOf(e)}`;
      return false;
    }
    this.live = true;
    return true;
  }

  private dropUpstream(): void {
    this.live = false;
    const { ur, uw } = this;
    this.ur = null;
    this.uw = null;
    if (ur) void ur.cancel().catch(noop);
    if (uw) void uw.abort().catch(noop);
    closeQuietly(this.upstream);
    this.upstream = null;
  }

  /** Ends the current upstream's read side so pumpUp returns and the loop redials. */
  private cutUpstream(reason: string): void {
    this.live = false;
    this.upReason = reason;
    if (this.ur) void this.ur.cancel().catch(noop);
  }

  /** Resolves with why the upstream ended; a client write failure ends the session instead. */
  private async pumpUp(ur: Reader, cw: Writer): Promise<string> {
    for (;;) {
      let r: ReadableStreamReadResult<Uint8Array>;
      try {
        r = await ur.read();
      } catch (e) {
        return `error ${msgOf(e)}`;
      }
      if (r.done) return this.upReason ?? 'FIN';
      try {
        await cw.write(r.value);
      } catch (e) {
        this.finish('E', `error ${msgOf(e)}`);
        this.teardown();
        return 'client write failed';
      }
      this.bytesDown += r.value.byteLength;
    }
  }

  private async pumpClient(cr: Reader): Promise<void> {
    try {
      for (;;) {
        const { done, value } = await cr.read();
        if (done) break;
        await this.sendUp(value);
        if (this.isFinished()) return;
      }
    } catch (e) {
      this.finish('E', `error ${msgOf(e)}`);
      this.teardown();
      return;
    }
    this.finish('E', 'FIN');
    const uw = this.uw;
    if (!this.live || !uw) {
      this.teardown();
      return;
    }
    try {
      await uw.close(); // half-close: DeckBridge answers, then ends
    } catch {
      this.teardown();
    }
  }

  private async sendUp(chunk: Uint8Array): Promise<void> {
    const uw = this.live ? this.uw : null;
    if (uw) {
      try {
        await uw.write(chunk);
        this.bytesUp += chunk.byteLength;
        return;
      } catch (e) {
        if (this.isFinished()) return;
        // Not delivered, so it is replayed to the next upstream.
        if (this.uw === uw) this.cutUpstream(`error ${msgOf(e)}`);
      }
    }
    if (this.bufBytes + chunk.byteLength > HOLD_BUFFER_CAP) {
      this.finish('relay', 'hold buffer full');
      this.teardown();
      return;
    }
    this.buf.push(chunk);
    this.bufBytes += chunk.byteLength;
    // A new upstream went live while that write was failing.
    if (this.live && this.uw && this.uw !== uw && !(await this.flush(this.uw))) {
      this.cutUpstream(this.upReason ?? 'error');
    }
  }
}
