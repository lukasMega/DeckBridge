// Node-net-like TCP API backed by txiki.js tjs.connect / tjs.listen globals.
// Concentrates all impedance mismatch in one place so cora-server-base.ts
// and elgato.ts only need a one-line import change.
// No tjs:* import needed — tjs is a global provided at runtime.
//
// No write backpressure: write() fires-and-forgets the writer.write()
// promise (errors are still caught and routed to the 'error'/close path).
// This is acceptable because all CORA frames are bounded to <=512 bytes —
// at that size the OS socket buffer absorbs writes far faster than the
// 1024B Elgato legacy packets or CORA frames can be produced, so the
// unawaited promise never represents meaningful unbounded queuing. If a
// future caller needs to stream larger payloads, add backpressure here.

type DataCb = (chunk: Buffer) => void;
type CloseCb = (hadError: boolean) => void;
type ErrorCb = (err: Error) => void;

export class NodeLikeSocket {
  remoteAddress = '';
  private _cbs = { data: [] as DataCb[], close: [] as CloseCb[], error: [] as ErrorCb[] };
  private _writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private _reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private _destroyed = false;

  /** @internal — called after socket opens with its readable/writable streams */
  _attach(
    readable: ReadableStream<Uint8Array>,
    writable: WritableStream<Uint8Array>,
    remoteAddr: string,
  ): void {
    this.remoteAddress = remoteAddr;
    this._writer = writable.getWriter();
    void this._pump(readable);
  }

  /** @internal — called on pre-connection error */
  _emitError(err: Error): void {
    for (const cb of this._cbs.error) cb(err);
  }

  private async _pump(readable: ReadableStream<Uint8Array>): Promise<void> {
    const reader = readable.getReader();
    this._reader = reader;
    let hadError = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // Wrap Uint8Array in Buffer so callers can use Buffer methods (readUInt16LE, etc.)
        const chunk = Buffer.from(value);
        for (const cb of this._cbs.data) cb(chunk);
      }
    } catch (e) {
      hadError = true;
      const err = e instanceof Error ? e : new Error(String(e));
      for (const cb of this._cbs.error) cb(err);
    } finally {
      reader.releaseLock();
      if (!this._destroyed) {
        this._destroyed = true;
        for (const cb of this._cbs.close) cb(hadError);
      }
    }
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
    if (this._destroyed || !this._writer) return;
    void this._writer.write(data).catch((e: unknown) => {
      const err = e instanceof Error ? e : new Error(String(e));
      queueMicrotask(() => {
        for (const handler of this._cbs.error) {
          handler(err);
        }
        this.destroy();
      });
    });
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    void this._writer?.close().catch(() => {});
    void this._reader?.cancel().catch(() => {});
    queueMicrotask(() => {
      for (const cb of this._cbs.close) cb(false);
    });
  }
}

export class NodeLikeServer {
  private readonly _handler: (socket: NodeLikeSocket) => void;
  private _serverClose: (() => void) | null = null;
  private _errorCbs: Array<(err: Error) => void> = [];

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
    void (async () => {
      try {
        const server = await tjs.listen('tcp', host, port);
        this._serverClose = () => server.close();
        const info = await server.opened;
        cb();
        await this._acceptLoop(info.readable);
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        for (const ecb of this._errorCbs) ecb(err);
      }
    })();
  }

  private async _acceptLoop(readable: ReadableStream<TjsAcceptedSocket>): Promise<void> {
    const reader = readable.getReader();
    try {
      for (;;) {
        const { done, value: conn } = await reader.read();
        if (done) break;
        void (async () => {
          try {
            const info = await conn.opened;
            const sock = new NodeLikeSocket();
            sock._attach(info.readable, info.writable, info.remoteAddress ?? '');
            this._handler(sock);
          } catch {
            // connection failed to open — ignore
          }
        })();
      }
    } finally {
      reader.releaseLock();
    }
  }

  close(cb: () => void): void {
    if (this._serverClose) {
      this._serverClose();
      this._serverClose = null;
    }
    cb();
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
  void (async () => {
    try {
      const socket = await tjs.connect('tcp', opts.host, opts.port);
      const info = await socket.opened;
      nodeSocket._attach(info.readable, info.writable, info.remoteAddress);
      cb();
    } catch (e) {
      nodeSocket._emitError(e instanceof Error ? e : new Error(String(e)));
    }
  })();
  return nodeSocket;
}

// Internal type helpers (not exported)
interface TjsSocketOpenedInfo {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  remoteAddress?: string;
  remotePort?: number;
  localAddress?: string;
  localPort?: number;
}

interface TjsAcceptedSocket {
  readonly opened: Promise<TjsSocketOpenedInfo>;
  close(): void;
}
