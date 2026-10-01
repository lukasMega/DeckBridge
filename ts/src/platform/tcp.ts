// Node-net-like TCP API backed by the txiki.js tjs.connect / tjs.listen globals (no
// tjs:* import needed — tjs is a runtime global).
//
// No write backpressure: write() fires-and-forgets writer.write() (errors still route
// to the 'error'/close path). Safe only because every CORA frame is <=512 bytes, so the
// OS socket buffer drains faster than frames are produced. Add backpressure here before
// streaming anything larger.
//
// Terminal cleanup closes the native handle itself: txiki only closes it once BOTH stream
// halves finish, so a peer FIN (readable done, writable still locked) would otherwise
// leak the descriptor.

/** tjs rejects with plain values as well as Errors; callbacks here take an Error. */
const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

const noop = (): void => {};

/** Run every callback even if one throws; rethrow outside cleanup like an unhandled callback. */
function emitAll<T>(cbs: Array<(arg: T) => void>, arg: T): void {
  for (const cb of cbs) {
    try {
      cb(arg);
    } catch (e) {
      queueMicrotask(() => {
        throw e;
      });
    }
  }
}

function closeQuietly(native: { close(): void }): void {
  try {
    native.close();
  } catch {
    // already closed
  }
}

type DataCb = (chunk: Buffer) => void;
type CloseCb = (hadError: boolean) => void;
type ErrorCb = (err: Error) => void;

interface NativeSocket {
  close(): void;
}

export class NodeLikeSocket {
  remoteAddress = '';
  private _cbs = { data: [] as DataCb[], close: [] as CloseCb[], error: [] as ErrorCb[] };
  private _native: NativeSocket | null = null;
  private _writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private _reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  /** Set once terminal cleanup starts; no new writes or attachments after this. */
  private _closing = false;
  private _hadError = false;
  private _cleanup: Promise<void> | null = null;
  /** Aborts a connect still in flight (createConnection only). */
  _connectAbort: AbortController | null = null;

  get destroyed(): boolean {
    return this._closing;
  }

  /** Settles once the native handle is closed and both stream locks are released. */
  get cleanup(): Promise<void> {
    return this._cleanup ?? Promise.resolve();
  }

  /** @internal — called once the socket opens. Returns false when it lost the race
   *  with destroy(); the handle is closed then and must not be used. */
  _attach(
    native: NativeSocket,
    readable: ReadableStream<Uint8Array>,
    writable: WritableStream<Uint8Array>,
    remoteAddr: string,
  ): boolean {
    if (this._closing) {
      closeQuietly(native);
      void readable.cancel().catch(noop);
      void writable.abort().catch(noop);
      return false;
    }
    this._native = native;
    this.remoteAddress = remoteAddr;
    this._writer = writable.getWriter();
    this._reader = readable.getReader();
    void this._pump(this._reader);
    return true;
  }

  /** @internal — called on pre-connection error */
  _emitError(err: Error): void {
    if (this._closing) return;
    this._closing = true;
    emitAll(this._cbs.error, err);
  }

  private async _pump(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || this._closing) break;
        // Wrap, don't copy: callers get Buffer methods without copying every inbound
        // byte, and CoraFrameBuffer.append concats it away immediately. Safe because
        // txiki allocates a fresh buffer per read. See Buffer.wrap for the caveats.
        const chunk = Buffer.wrap(value);
        for (const cb of this._cbs.data) cb(chunk);
      }
    } catch (e) {
      this._fail(asError(e));
      return;
    }
    this._terminate();
  }

  /** First transport failure wins `hadError`; error listeners run after cleanup started. */
  private _fail(err: Error): void {
    if (this._closing) return;
    this._hadError = true;
    this._terminate();
    emitAll(this._cbs.error, err);
  }

  private _terminate(): void {
    if (this._closing) return;
    this._closing = true;
    this._connectAbort?.abort();
    this._connectAbort = null;
    const reader = this._reader;
    const writer = this._writer;
    const native = this._native;
    // Abort, not writer.close(): a graceful close waits behind queued writes.
    const settles: Promise<unknown>[] = [];
    if (reader) settles.push(reader.cancel().catch(noop));
    if (writer) settles.push(writer.abort().catch(noop));
    if (native) closeQuietly(native);
    this._cleanup = this._release(settles, reader, writer);
    const hadError = this._hadError;
    queueMicrotask(() => emitAll(this._cbs.close, hadError));
  }

  private async _release(
    settles: Promise<unknown>[],
    reader: ReadableStreamDefaultReader<Uint8Array> | null,
    writer: WritableStreamDefaultWriter<Uint8Array> | null,
  ): Promise<void> {
    await Promise.all(settles);
    reader?.releaseLock();
    writer?.releaseLock();
    this._reader = null;
    this._writer = null;
    this._native = null;
  }

  on(event: 'data', cb: DataCb): this;
  on(event: 'close', cb: CloseCb): this;
  on(event: 'error', cb: ErrorCb): this;
  on(event: 'data' | 'close' | 'error', cb: DataCb | CloseCb | ErrorCb): this {
    if (event === 'data') this._cbs.data.push(cb as DataCb);
    else if (event === 'close') this._cbs.close.push(cb as CloseCb);
    else this._cbs.error.push(cb as ErrorCb);
    return this;
  }

  write(data: Uint8Array): void {
    if (this._closing || !this._writer) return;
    void this._writer.write(data).catch((e: unknown) => {
      const err = asError(e);
      queueMicrotask(() => this._fail(err));
    });
  }

  destroy(): void {
    this._terminate();
  }
}

export class NodeLikeServer {
  private readonly _handler: (socket: NodeLikeSocket) => void;
  private _errorCbs: Array<(err: Error) => void> = [];
  /** Bumped by close(): a listen/accept that resumes under an older generation is stale. */
  private _generation = 0;
  private _native: TjsTCPServerSocket | null = null;
  private _acceptReader: ReadableStreamDefaultReader<TjsAcceptedTCPSocket> | null = null;
  private _acceptLoop: Promise<void> | null = null;

  constructor(handler: (socket: NodeLikeSocket) => void) {
    this._handler = handler;
  }

  on(event: 'error', cb: (err: Error) => void): this {
    this._errorCbs.push(cb);
    return this;
  }

  removeListener(event: 'error', cb: (err: Error) => void): this {
    const i = this._errorCbs.indexOf(cb);
    if (i !== -1) this._errorCbs.splice(i, 1);
    return this;
  }

  listen(port: number, host: string, cb: () => void): void {
    const generation = this._generation;
    void (async () => {
      let server: TjsTCPServerSocket | null = null;
      try {
        server = await tjs.listen('tcp', host, port);
        if (generation !== this._generation) {
          closeQuietly(server);
          return;
        }
        const info = await server.opened;
        if (generation !== this._generation) {
          closeQuietly(server);
          return;
        }
        this._native = server;
        this._acceptReader = info.readable.getReader();
        this._acceptLoop = this._runAcceptLoop(this._acceptReader, generation);
        cb();
      } catch (e) {
        if (server && this._native !== server) closeQuietly(server);
        if (generation !== this._generation) return;
        emitAll(this._errorCbs, asError(e));
      }
    })();
  }

  private async _runAcceptLoop(
    reader: ReadableStreamDefaultReader<TjsAcceptedTCPSocket>,
    generation: number,
  ): Promise<void> {
    try {
      for (;;) {
        const { done, value: conn } = await reader.read();
        if (done) break;
        if (generation !== this._generation) {
          closeQuietly(conn);
          continue;
        }
        void this._adopt(conn, generation);
      }
    } catch {
      // accept stream errored — the server is unusable; close() still cleans up
    } finally {
      reader.releaseLock();
    }
  }

  private async _adopt(conn: TjsAcceptedTCPSocket, generation: number): Promise<void> {
    let info: TjsTCPOpenedInfo;
    try {
      info = await conn.opened;
    } catch {
      closeQuietly(conn);
      return;
    }
    if (generation !== this._generation) {
      closeQuietly(conn);
      return;
    }
    const sock = new NodeLikeSocket();
    sock._attach(conn, info.readable, info.writable, info.remoteAddress);
    this._handler(sock);
  }

  /** Stops listening (including a listen still starting) and calls `cb` once the
   *  accept loop has released its reader. Accepted client sockets are not closed. */
  close(cb: () => void): void {
    this._generation++;
    const server = this._native;
    const reader = this._acceptReader;
    const loop = this._acceptLoop;
    this._native = null;
    this._acceptReader = null;
    this._acceptLoop = null;
    const cancelled = reader ? reader.cancel().catch(noop) : Promise.resolve();
    if (server) closeQuietly(server);
    void (async () => {
      await Promise.all([cancelled, loop]);
      cb();
    })();
  }
}

// Type aliases so `import * as net from './platform/tcp.js'` provides
// net.Socket and net.Server that match the original cora-server-base usage.
export type Socket = NodeLikeSocket;
export type Server = NodeLikeServer;

export function createServer(handler: (socket: NodeLikeSocket) => void): NodeLikeServer {
  return new NodeLikeServer(handler);
}

export function createConnection(
  opts: { host: string; port: number },
  cb: () => void,
): NodeLikeSocket {
  const nodeSocket = new NodeLikeSocket();
  const abort = new AbortController();
  nodeSocket._connectAbort = abort;
  void (async () => {
    let socket: TjsTCPSocket | null = null;
    try {
      socket = await tjs.connect('tcp', opts.host, opts.port, { signal: abort.signal });
      const info = await socket.opened;
      if (nodeSocket._connectAbort !== abort) {
        closeQuietly(socket);
        return;
      }
      nodeSocket._connectAbort = null;
      if (nodeSocket._attach(socket, info.readable, info.writable, info.remoteAddress)) cb();
    } catch (e) {
      if (socket) closeQuietly(socket);
      if (nodeSocket._connectAbort !== abort) return;
      nodeSocket._connectAbort = null;
      nodeSocket._emitError(asError(e));
    }
  })();
  return nodeSocket;
}
