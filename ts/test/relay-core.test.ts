import assert from 'tjs:assert';
import { CoraRelay } from '../src/main/relay/relay.js';
import type { RelaySessionClose } from '../src/main/relay/relay.js';
import { testAsync, summaryExit } from './helpers/harness.js';

const HOST = '127.0.0.1';
let nextPort = 48610 + (tjs.pid % 100);
const port = (): number => nextPort++;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timeout: ${what}`)), ms)),
  ]);
}

interface FakeUpstream {
  port: number;
  close(): Promise<void>;
}

async function echo(conn: TjsAcceptedTCPSocket): Promise<void> {
  const c = await conn.opened;
  const reader = c.readable.getReader();
  const writer = c.writable.getWriter();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await writer.write(value);
    }
    await writer.close();
  } catch {
    // the relay went away
  }
}

/** Echoes every byte back; 'close-on-accept' drops each connection at once. */
async function fakeUpstream(mode: 'echo' | 'close-on-accept'): Promise<FakeUpstream> {
  const p = port();
  const server = await tjs.listen('tcp', HOST, p);
  const info = await server.opened;
  const accept = info.readable.getReader();
  const conns: TjsAcceptedTCPSocket[] = [];

  const loop = (async (): Promise<void> => {
    try {
      for (;;) {
        const { done, value: conn } = await accept.read();
        if (done) break;
        conns.push(conn);
        if (mode === 'echo') void echo(conn);
        else conn.close();
      }
    } catch {
      // closed
    }
  })();

  return {
    port: p,
    async close(): Promise<void> {
      await accept.cancel().catch(() => {});
      server.close();
      await loop;
      for (const c of conns) c.close();
    },
  };
}

interface Client {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  readExact(n: number): Promise<Uint8Array>;
  /** Reads until EOF or error; resolves with the byte count. */
  drain(): Promise<number>;
  close(): void;
}

async function connectClient(p: number): Promise<Client> {
  const sock = await tjs.connect('tcp', HOST, p);
  const info = await sock.opened;
  const reader = info.readable.getReader();
  const writer = info.writable.getWriter();
  return {
    writer,
    async readExact(n: number): Promise<Uint8Array> {
      const out = new Uint8Array(n);
      let got = 0;
      while (got < n) {
        const { done, value } = await within(reader.read(), 3000, 'client read');
        if (done) throw new Error(`EOF after ${got} of ${n} bytes`);
        out.set(value.subarray(0, n - got), got);
        got += Math.min(value.length, n - got);
      }
      return out;
    },
    async drain(): Promise<number> {
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await within(reader.read(), 3000, 'client drain');
          if (done) break;
          total += value.length;
        }
      } catch (e) {
        if (String(e).includes('timeout')) throw e;
      }
      return total;
    },
    close(): void {
      sock.close();
    },
  };
}

function pattern(n: number, seed: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xff;
  return b;
}

function assertBytes(actual: Uint8Array, expected: Uint8Array): void {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) throw new Error(`byte ${i} differs`);
  }
}

/** Collects onClose calls; `next()` resolves with the next one. */
function closeCollector(): {
  onClose: (s: RelaySessionClose) => void;
  next: () => Promise<RelaySessionClose>;
} {
  const queue: RelaySessionClose[] = [];
  const waiters: Array<(s: RelaySessionClose) => void> = [];
  return {
    onClose(s): void {
      const w = waiters.shift();
      if (w) w(s);
      else queue.push(s);
    },
    next(): Promise<RelaySessionClose> {
      const s = queue.shift();
      if (s) return Promise.resolve(s);
      return within(new Promise((r) => waiters.push(r)), 3000, 'onClose');
    },
  };
}

async function startRelay(
  targetPort: number,
  onClose?: (s: RelaySessionClose) => void,
  onOpen?: (id: number, route: 'main' | 'child', client: string) => void,
): Promise<{ relay: CoraRelay; listenPort: number }> {
  const listenPort = port();
  const relay = new CoraRelay({
    listenHost: HOST,
    targetHost: HOST,
    routes: [{ name: 'main', listenPort, targetPort }],
    connectTimeoutMs: 2000,
    onOpen,
    onClose,
  });
  await relay.start();
  return { relay, listenPort };
}

await testAsync('bytes pass unchanged both ways, including a 200 KB write', async () => {
  const up = await fakeUpstream('echo');
  const opened: Array<[number, string]> = [];
  const { relay, listenPort } = await startRelay(up.port, undefined, (id, route) => {
    opened.push([id, route]);
  });
  const c = await connectClient(listenPort);
  const small = pattern(100, 1);
  await c.writer.write(small);
  assertBytes(await c.readExact(small.length), small);
  const big = pattern(200 * 1024, 7);
  const writing = c.writer.write(big);
  assertBytes(await c.readExact(big.length), big);
  await within(writing, 3000, 'big write');
  assert.equal(relay.openSessions(), 1);
  assert.equal(relay.openSessions('child'), 0);
  assert.deepEqual(opened, [[1, 'main']]);
  c.close();
  await relay.stop();
  assert.equal(relay.openSessions(), 0);
  await up.close();
});

await testAsync('client closes first: closedBy E, FIN, byte counts', async () => {
  const up = await fakeUpstream('echo');
  const col = closeCollector();
  const { relay, listenPort } = await startRelay(up.port, col.onClose);
  const c = await connectClient(listenPort);
  const data = pattern(1000, 3);
  await c.writer.write(data);
  assertBytes(await c.readExact(1000), data);
  await c.writer.close();
  assert.equal(await c.drain(), 0);
  const s = await col.next();
  assert.equal(s.closedBy, 'E');
  assert.equal(s.how, 'FIN');
  assert.equal(s.route, 'main');
  assert.equal(s.bytesUp, 1000);
  assert.equal(s.bytesDown, 1000);
  assert.ok(s.client.startsWith(`${HOST}:`));
  c.close();
  await relay.stop();
  await up.close();
});

await testAsync('upstream closes first: closedBy D', async () => {
  const up = await fakeUpstream('close-on-accept');
  const col = closeCollector();
  const { relay, listenPort } = await startRelay(up.port, col.onClose);
  const c = await connectClient(listenPort);
  assert.equal(await c.drain(), 0);
  await c.writer.close();
  const s = await col.next();
  assert.equal(s.closedBy, 'D');
  assert.equal(s.how, 'FIN');
  c.close();
  await relay.stop();
  await up.close();
});

await testAsync('upstream not listening: client is closed, closedBy relay', async () => {
  const col = closeCollector();
  const { relay, listenPort } = await startRelay(port(), col.onClose); // nothing listens there
  const c = await connectClient(listenPort);
  assert.equal(await c.drain(), 0);
  const s = await col.next();
  assert.equal(s.closedBy, 'relay');
  assert.ok(s.how.startsWith('connect failed'), s.how);
  assert.equal(s.bytesUp, 0);
  c.close();
  await relay.stop();
});

await testAsync('stop() ends an open session with how=shutdown', async () => {
  const up = await fakeUpstream('echo');
  const col = closeCollector();
  const { relay, listenPort } = await startRelay(up.port, col.onClose);
  const c = await connectClient(listenPort);
  await c.writer.write(pattern(10, 5));
  await c.readExact(10);
  assert.equal(relay.openSessions(), 1);
  await within(relay.stop(), 3000, 'stop');
  assert.equal(relay.openSessions(), 0);
  const s = await col.next();
  assert.equal(s.closedBy, 'relay');
  assert.equal(s.how, 'shutdown');
  assert.equal(await c.drain(), 0);
  c.close();
  await up.close();
});

await testAsync('two concurrent sessions on one route both relay correctly', async () => {
  const up = await fakeUpstream('echo');
  const col = closeCollector();
  const { relay, listenPort } = await startRelay(up.port, col.onClose);
  const a = await connectClient(listenPort);
  const b = await connectClient(listenPort);
  const da = pattern(5000, 11);
  const db = pattern(7000, 99);
  await Promise.all([a.writer.write(da), b.writer.write(db)]);
  const [ra, rb] = await Promise.all([a.readExact(da.length), b.readExact(db.length)]);
  assertBytes(ra, da);
  assertBytes(rb, db);
  assert.equal(relay.openSessions(), 2);
  await a.writer.close();
  await b.writer.close();
  await Promise.all([a.drain(), b.drain()]);
  const closes = [await col.next(), await col.next()];
  assert.deepEqual(
    closes.map((s) => s.id).toSorted((x, y) => x - y),
    [1, 2],
  );
  assert.deepEqual(
    closes.map((s) => s.bytesUp).toSorted((x, y) => x - y),
    [5000, 7000],
  );
  a.close();
  b.close();
  await relay.stop();
  await sleep(0);
  await up.close();
});

summaryExit();
