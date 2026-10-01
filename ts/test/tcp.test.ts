import assert from 'tjs:assert';
import { createConnection, createServer, NodeLikeSocket } from '../src/platform/tcp.js';
import type { NodeLikeServer } from '../src/platform/tcp.js';
import { testAsync, summaryExit } from './helpers/harness.js';

const HOST = '127.0.0.1';
let nextPort = 47610 + (tjs.pid % 200);
const port = (): number => nextPort++;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timeout: ${what}`)), ms)),
  ]);
}

function listen(srv: NodeLikeServer, p: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error): void => reject(e);
    srv.on('error', onError);
    srv.listen(p, HOST, () => {
      srv.removeListener('error', onError);
      resolve();
    });
  });
}

const closeServer = (srv: NodeLikeServer): Promise<void> =>
  new Promise((resolve) => srv.close(resolve));

/** Server whose accepted NodeLikeSockets are handed out in order. */
async function acceptingServer(): Promise<{
  srv: NodeLikeServer;
  port: number;
  next: () => Promise<NodeLikeSocket>;
}> {
  const queue: NodeLikeSocket[] = [];
  const waiters: Array<(s: NodeLikeSocket) => void> = [];
  const srv = createServer((s) => {
    const w = waiters.shift();
    if (w) w(s);
    else queue.push(s);
  });
  const p = port();
  await listen(srv, p);
  const next = (): Promise<NodeLikeSocket> => {
    const s = queue.shift();
    if (s) return Promise.resolve(s);
    return new Promise((r) => waiters.push(r));
  };
  return { srv, port: p, next };
}

function closeEvents(sock: NodeLikeSocket): boolean[] {
  const events: boolean[] = [];
  sock.on('close', (hadError) => events.push(hadError));
  return events;
}

/** Open descriptors of this process, or null where the platform has no fd dir. */
async function fdCount(): Promise<number | null> {
  for (const dir of ['/proc/self/fd', '/dev/fd']) {
    try {
      let n = 0;
      for await (const entry of await tjs.readDir(dir)) if (entry.name) n++;
      return n;
    } catch {
      // try next
    }
  }
  return null;
}

function fakeNative(): { close(): void; closes: number } {
  return {
    closes: 0,
    close() {
      this.closes++;
    },
  };
}

await testAsync('peer FIN closes the native socket and releases both locks', async () => {
  const { srv, port: p, next } = await acceptingServer();
  const client = await tjs.connect('tcp', HOST, p);
  const { readable, writable } = await client.opened;
  const server = await next();
  const events = closeEvents(server);

  const writer = writable.getWriter();
  await writer.close(); // FIN from the peer
  await within(server.cleanup, 1000, 'server cleanup');
  // Our side closed its handle, so the peer's read now ends instead of hanging.
  const reader = readable.getReader();
  const r = await within(reader.read(), 1000, 'peer EOF');
  assert.ok(r.done, 'peer sees EOF once the server side closed');
  await sleep(0);
  assert.deepEqual(events, [false]);
  assert.ok(server.destroyed);

  reader.releaseLock();
  writer.releaseLock();
  client.close();
  await closeServer(srv);
});

await testAsync('FIN then destroy: one close notification', async () => {
  const { srv, port: p, next } = await acceptingServer();
  const client = await tjs.connect('tcp', HOST, p);
  const { writable } = await client.opened;
  const server = await next();
  const events = closeEvents(server);
  const writer = writable.getWriter();
  await writer.close();
  await within(server.cleanup, 1000, 'cleanup');
  server.destroy();
  server.destroy();
  await sleep(10);
  assert.deepEqual(events, [false]);
  client.close();
  await closeServer(srv);
});

await testAsync('repeated destroy shares one cleanup and one close event', async () => {
  const { srv, port: p, next } = await acceptingServer();
  const client = await tjs.connect('tcp', HOST, p);
  await client.opened;
  const server = await next();
  const events = closeEvents(server);
  server.destroy();
  const first = server.cleanup;
  server.destroy();
  assert.equal(server.cleanup, first);
  await within(first, 1000, 'cleanup');
  await sleep(10);
  assert.deepEqual(events, [false]);
  client.close();
  await closeServer(srv);
});

await testAsync(
  'read failure reports the error, closes with hadError, still cleans up',
  async () => {
    const sock = new NodeLikeSocket();
    const native = fakeNative();
    const errors: string[] = [];
    sock.on('error', (e) => {
      errors.push(e.message);
      sock.destroy(); // what CoraServerBase does
    });
    const events = closeEvents(sock);
    const readable = new ReadableStream<Uint8Array>({
      pull(c) {
        c.error(new Error('ECONNRESET'));
      },
    });
    let aborted = false;
    const writable = new WritableStream<Uint8Array>({
      abort() {
        aborted = true;
      },
    });
    sock._attach(native, readable, writable, 'x');
    await within(
      sock.cleanup.then(() => sleep(0)),
      1000,
      'cleanup',
    );
    await sleep(0);
    assert.deepEqual(errors, ['ECONNRESET']);
    assert.deepEqual(events, [true]);
    assert.equal(native.closes, 1);
    assert.ok(aborted, 'writable aborted, not gracefully closed');
    assert.ok(!readable.locked && !writable.locked, 'locks released');
  },
);

await testAsync('write failure: error then close(true), no duplicate close', async () => {
  const sock = new NodeLikeSocket();
  const native = fakeNative();
  const errors: string[] = [];
  sock.on('error', (e) => {
    errors.push(e.message);
    sock.destroy();
  });
  const events = closeEvents(sock);
  const readable = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
  const writable = new WritableStream<Uint8Array>({
    write() {
      throw new Error('EPIPE');
    },
  });
  sock._attach(native, readable, writable, 'x');
  sock.write(new Uint8Array([1]));
  await within(
    sock.cleanup.then(() => sleep(10)),
    1000,
    'cleanup',
  );
  assert.deepEqual(errors, ['EPIPE']);
  assert.deepEqual(events, [true]);
  assert.equal(native.closes, 1);
  assert.ok(!readable.locked && !writable.locked);
});

await testAsync('a throwing data listener cannot block resource release', async () => {
  const sock = new NodeLikeSocket();
  const native = fakeNative();
  sock.on('data', () => {
    throw new Error('listener bug');
  });
  sock.on('error', () => {});
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array([1]));
    },
  });
  const closed = new Promise<void>((r) => sock.on('close', () => r()));
  sock._attach(native, readable, new WritableStream<Uint8Array>(), 'x');
  await within(
    closed.then(() => sock.cleanup),
    1000,
    'cleanup',
  );
  assert.equal(native.closes, 1);
  assert.ok(!readable.locked);
});

await testAsync('stalled writes do not delay destroy', async () => {
  const { srv, port: p, next } = await acceptingServer();
  const client = await tjs.connect('tcp', HOST, p);
  await client.opened; // never reads: the server's writes back up
  const server = await next();
  const chunk = new Uint8Array(1 << 20);
  for (let i = 0; i < 64; i++) server.write(chunk);
  await sleep(20);
  const t0 = Date.now();
  server.destroy();
  await within(server.cleanup, 1000, 'cleanup behind queued writes');
  assert.ok(Date.now() - t0 < 1000);
  client.close();
  await closeServer(srv);
});

await testAsync(
  'destroy before connect opens: callback suppressed, late handle closed',
  async () => {
    const { srv, port: p, next } = await acceptingServer();
    let connected = false;
    const sock = createConnection({ host: HOST, port: p }, () => {
      connected = true;
    });
    const errors: Error[] = [];
    sock.on('error', (e) => errors.push(e));
    sock.destroy();
    // If the dial still reached the listener, our side must have closed it.
    const accepted = await Promise.race([next(), sleep(300).then(() => null)]);
    if (accepted) {
      const events = closeEvents(accepted);
      await within(
        new Promise<void>((r) => accepted.on('close', () => r())),
        1000,
        'late handle closed',
      );
      assert.deepEqual(events, [false]);
    }
    await sleep(50);
    assert.ok(!connected, 'connect callback suppressed');
    assert.equal(errors.length, 0);
    await closeServer(srv);
  },
);

await testAsync('connect error is reported once, no connect callback', async () => {
  const p = port(); // nothing listens here
  let connected = false;
  const sock = createConnection({ host: HOST, port: p }, () => {
    connected = true;
  });
  const err = await within(new Promise<Error>((r) => sock.on('error', r)), 2000, 'connect error');
  assert.ok(err instanceof Error);
  assert.ok(!connected);
  sock.destroy(); // what ChildReconnector does; must stay a no-op
});

await testAsync('close during listen: no late activation, port freed', async () => {
  const p = port();
  let listening = false;
  const srv = createServer(() => {});
  srv.listen(p, HOST, () => {
    listening = true;
  });
  await closeServer(srv);
  await sleep(100);
  assert.ok(!listening, 'listen callback suppressed after close');
  // The port is free again: a fresh server binds it.
  const again = createServer(() => {});
  await within(listen(again, p), 1000, 'rebind');
  await closeServer(again);
});

await testAsync('close stops accepting and later dials are refused', async () => {
  const { srv, port: p } = await acceptingServer();
  await closeServer(srv);
  let failed = false;
  try {
    const c = await tjs.connect('tcp', HOST, p);
    c.close();
  } catch {
    failed = true;
  }
  assert.ok(failed, 'listener is gone');
});

await testAsync('bind failure then retry on the same server object', async () => {
  const p = port();
  const holder = createServer(() => {});
  await listen(holder, p);
  const srv = createServer(() => {});
  let bindErr: Error | null = null;
  try {
    await listen(srv, p);
  } catch (e) {
    bindErr = e as Error;
  }
  assert.ok(bindErr, 'second bind fails');
  await closeServer(holder);
  await within(listen(srv, p), 1000, 'retry after the port frees');
  await closeServer(srv);
});

await testAsync('200 FIN-driven reconnect cycles return descriptors to baseline', async () => {
  const { srv, port: p, next } = await acceptingServer();
  const before = await fdCount();
  for (let i = 0; i < 200; i++) {
    const client = await tjs.connect('tcp', HOST, p);
    const { writable } = await client.opened;
    const server = await next();
    const writer = writable.getWriter();
    await writer.close();
    await within(server.cleanup, 1000, `cleanup ${i}`);
    writer.releaseLock();
    client.close();
  }
  await sleep(50);
  const after = await fdCount();
  if (before !== null && after !== null) {
    assert.ok(after - before < 10, `descriptors grew from ${before} to ${after}`);
  }
  await closeServer(srv);
});

summaryExit();
