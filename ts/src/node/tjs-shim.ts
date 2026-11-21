// The `tjs` subset the relay core (main/relay/**) uses, on top of Node.js, so one relay
// source runs on both. Sockets keep the tjs Direct-Sockets shape (`opened` → web streams).
import * as net from 'node:net';
import * as os from 'node:os';
import process from 'node:process';
import { KEEPALIVE_DELAY_S } from '../platform/accept-guard.js';

interface ConnectOptions {
  signal?: AbortSignal;
  noDelay?: boolean;
  keepAliveDelay?: number;
}

// allowHalfOpen: Node ends the write side on the peer's FIN otherwise; the relay half-closes.
const ACCEPT_OPTIONS: net.SocketOptions = {
  allowHalfOpen: true,
  noDelay: true,
  keepAlive: true,
  keepAliveInitialDelay: KEEPALIVE_DELAY_S * 1000,
};

function settle(fn: () => void): void {
  try {
    fn();
  } catch {
    // stream already closed, errored or cancelled
  }
}

// Not Duplex.toWeb: on Node 20 its readable never ends on a FIN while the write side is open.
function readableOf(sock: net.Socket): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      sock.on('data', (chunk) => {
        c.enqueue(chunk);
        if ((c.desiredSize ?? 1) <= 0) sock.pause();
      });
      sock.on('end', () => settle(() => c.close()));
      sock.on('error', (e) => settle(() => c.error(e)));
      sock.on('close', () => settle(() => c.close()));
    },
    pull() {
      sock.resume();
    },
    cancel() {
      sock.destroy();
    },
  });
}

const settled =
  (resolve: () => void, reject: (e: Error) => void) =>
  (e?: Error | null): void =>
    e ? reject(e) : resolve();

// Resolve on flush: the relay pumps await each write for backpressure.
function writableOf(sock: net.Socket): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write: (chunk) => new Promise((res, rej) => void sock.write(chunk, settled(res, rej))),
    close: () => new Promise((res, rej) => void sock.end(settled(res, rej))),
    abort() {
      sock.destroy();
    },
  });
}

function wrapSocket(sock: net.Socket): TjsAcceptedTCPSocket & TjsTCPSocket {
  const readable = readableOf(sock);
  const writable = writableOf(sock);
  const info: TjsTCPOpenedInfo = {
    readable,
    writable,
    localAddress: sock.localAddress ?? '',
    localPort: sock.localPort ?? 0,
    remoteAddress: sock.remoteAddress ?? '',
    remotePort: sock.remotePort ?? 0,
  };
  return {
    opened: Promise.resolve(info),
    closed: new Promise<void>(() => {}),
    close: () => sock.destroy(),
  };
}

async function connect(
  _transport: 'tcp',
  host: string,
  port: number,
  opts: ConnectOptions = {},
): Promise<TjsTCPSocket> {
  const { signal } = opts;
  signal?.throwIfAborted();
  const sock = net.connect({
    host,
    port,
    allowHalfOpen: true,
    noDelay: opts.noDelay ?? false,
    keepAlive: opts.keepAliveDelay !== undefined,
    keepAliveInitialDelay: (opts.keepAliveDelay ?? 0) * 1000,
  });
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      sock.off('error', onError);
      sock.destroy();
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    const onError = (e: Error): void => {
      signal?.removeEventListener('abort', onAbort);
      reject(e);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    sock.once('error', onError);
    sock.once('connect', () => {
      signal?.removeEventListener('abort', onAbort);
      sock.off('error', onError);
      resolve();
    });
  });
  return wrapSocket(sock);
}

async function listen(_transport: 'tcp', host: string, port: number): Promise<TjsTCPServerSocket> {
  const server = net.createServer(ACCEPT_OPTIONS);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  let accepts: ReadableStreamDefaultController<TjsAcceptedTCPSocket> | null = null;
  const end = (): void => {
    server.close();
    try {
      accepts?.close();
    } catch {
      // already closed or cancelled
    }
    accepts = null;
  };
  const readable = new ReadableStream<TjsAcceptedTCPSocket>({
    start(c) {
      accepts = c;
    },
    cancel: end,
  });
  // Without a listener a late server error (EMFILE) is an uncaught exception; tjs errors
  // the accept stream instead, which CoraRelay.acceptLoop handles.
  server.on('error', (e) => {
    settle(() => accepts?.error(e));
    accepts = null;
  });
  server.on('connection', (s) => {
    if (accepts) accepts.enqueue(wrapSocket(s));
    else s.destroy();
  });
  const addr = server.address();
  const bound = typeof addr === 'object' && addr !== null ? addr : { address: host, port };
  return {
    opened: Promise.resolve({ readable, localAddress: bound.address, localPort: bound.port }),
    closed: new Promise<void>(() => {}),
    close: end,
  };
}

function networkInterfaces(): NetworkInterface[] {
  return Object.entries(os.networkInterfaces()).flatMap(([name, list]) =>
    (list ?? []).map((n) => ({
      name,
      address: n.address,
      netmask: n.netmask,
      mac: n.mac,
      internal: n.internal,
      ...(n.scopeid !== undefined ? { scopeId: n.scopeid } : {}),
    })),
  );
}

const SHIM: Record<string, unknown> = {
  connect,
  listen,
  env: process.env,
  pid: process.pid,
  args: process.argv,
  exit: (code?: number) => process.exit(code),
  addSignalListener: (sig: string, fn: () => void) => process.on(sig, fn),
  removeSignalListener: (sig: string, fn: () => void) => process.off(sig, fn),
  system: {
    get networkInterfaces() {
      return networkInterfaces();
    },
  },
};

function withResolvers<T>(): PromiseWithResolvers<T> {
  let resolve!: (v: T | PromiseLike<T>) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Installs `globalThis.tjs`; a member the relay never uses throws when read. */
export function installTjsShim(): void {
  // Node 20 has no Promise.withResolvers (run.ts uses it).
  (Promise as { withResolvers?: unknown }).withResolvers ??= withResolvers;
  (globalThis as { tjs?: unknown }).tjs = new Proxy(SHIM, {
    get(target, key) {
      if (typeof key !== 'string' || key in target) return target[key as string];
      throw new Error(`not in the Node.js relay: tjs.${key}`);
    },
  });
}
