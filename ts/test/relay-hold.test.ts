import assert from 'tjs:assert';
import { CoraRelay } from '../src/main/relay/relay.js';
import type { RelayOptions, RelaySessionClose } from '../src/main/relay/relay.js';
import { testAsync, summaryExit } from './helpers/harness.js';

const HOST = '127.0.0.1';
let nextPort = 48810 + (tjs.pid % 100);
const port = (): number => nextPort++;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timeout: ${what}`)), ms)),
  ]);
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

interface FakeUpstream {
  close(): Promise<void>;
}

/** Echo server on a fixed port, so a test can stop it and start another on the same port. */
async function fakeUpstream(p: number, host = HOST): Promise<FakeUpstream> {
  const server = await tjs.listen('tcp', host, p);
  const info = await server.opened;
  const accept = info.readable.getReader();
  const conns: TjsAcceptedTCPSocket[] = [];
  const loop = (async (): Promise<void> => {
    try {
      for (;;) {
        const { done, value: conn } = await accept.read();
        if (done) break;
        conns.push(conn);
        void echo(conn);
      }
    } catch {
      // closed
    }
  })();
  return {
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

async function connectClient(p: number, host = HOST): Promise<Client> {
  const sock = await tjs.connect('tcp', host, p);
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

/** Collects events; `next()` resolves with the next one. */
function collector<T>(what: string): { push: (v: T) => void; next: () => Promise<T>; all: T[] } {
  const queue: T[] = [];
  const all: T[] = [];
  const waiters: Array<(v: T) => void> = [];
  return {
    all,
    push(v): void {
      all.push(v);
      const w = waiters.shift();
      if (w) w(v);
      else queue.push(v);
    },
    next(): Promise<T> {
      if (queue.length > 0) return Promise.resolve(queue.shift() as T);
      return within(new Promise<T>((r) => waiters.push(r)), 3000, what);
    },
  };
}

interface Harness {
  relay: CoraRelay;
  listenPort: number;
  closes: ReturnType<typeof collector<RelaySessionClose>>;
  holds: ReturnType<typeof collector<string>>;
  resumes: ReturnType<typeof collector<number>>;
  lost: ReturnType<typeof collector<string>>;
}

async function startRelay(targetPort: number, extra: Partial<RelayOptions> = {}): Promise<Harness> {
  const listenPort = port();
  const closes = collector<RelaySessionClose>('onClose');
  const holds = collector<string>('onHold');
  const resumes = collector<number>('onResume');
  const lost = collector<string>('onUpstreamLost');
  const relay = new CoraRelay({
    listenHost: HOST,
    targetHost: HOST,
    routes: [{ name: 'main', listenPort, targetPort }],
    connectTimeoutMs: 1000,
    holdMs: 3000,
    redialBackoffMs: [50, 100],
    holdKeepaliveMs: 0, // echo tests compare exact bytes
    onClose: closes.push,
    onHold: (_id, _route, reason) => holds.push(reason),
    onResume: (_id, _route, heldMs) => resumes.push(heldMs),
    onUpstreamLost: (_route, reason) => lost.push(reason),
    ...extra,
  });
  await relay.start();
  return { relay, listenPort, closes, holds, resumes, lost };
}

await testAsync(
  'upstream restarts mid-session: client stays open, buffered bytes arrive',
  async () => {
    const up = port();
    let upstream = await fakeUpstream(up);
    const h = await startRelay(up);
    const c = await connectClient(h.listenPort);
    const first = pattern(100, 1);
    await c.writer.write(first);
    assertBytes(await c.readExact(100), first);

    await upstream.close();
    await within(h.holds.next(), 3000, 'hold');
    assert.ok((await h.lost.next()).length > 0);
    const during = pattern(300, 2);
    await c.writer.write(during); // parked in the relay
    await sleep(150);
    assert.equal(h.relay.openSessions(), 1);

    upstream = await fakeUpstream(up);
    const heldMs = await h.resumes.next();
    assert.ok(heldMs >= 0);
    assertBytes(await c.readExact(300), during); // echoed by the new upstream
    const after = pattern(50, 3);
    await c.writer.write(after);
    assertBytes(await c.readExact(50), after);

    await c.writer.close();
    await c.drain();
    const s = await h.closes.next();
    assert.equal(s.closedBy, 'E');
    assert.equal(s.bytesUp, 100 + 300 + 50);
    assert.equal(s.bytesDown, 100 + 300 + 50);
    c.close();
    await h.relay.stop();
    await upstream.close();
  },
);

/** True when `f` is a 48-byte CORA keepalive frame with this seq. */
function isKeepalive(f: Uint8Array, seq: number): boolean {
  const magic = [0x43, 0x93, 0x8a, 0x41];
  return (
    magic.every((b, i) => f[i] === b) &&
    f[8] === seq && // messageId = seq
    f[12] === 32 && // payload length
    f[16] === 0x01 &&
    f[17] === 0x0a &&
    f[21] === seq
  );
}

await testAsync('held client gets CORA keepalives; they stop on resume', async () => {
  const up = port();
  let upstream = await fakeUpstream(up);
  const h = await startRelay(up, { holdKeepaliveMs: 100 });
  const c = await connectClient(h.listenPort);
  await c.writer.write(pattern(10, 13));
  await c.readExact(10);

  await upstream.close();
  await h.holds.next();
  assert.ok(isKeepalive(await c.readExact(48), 0), 'first keepalive, sent at hold start');
  assert.ok(isKeepalive(await c.readExact(48), 1), 'second keepalive');

  upstream = await fakeUpstream(up);
  await h.resumes.next();
  const echoed = pattern(48, 14); // starts with 0x0e, never the CORA magic
  await c.writer.write(echoed);
  // Keepalives written before the resume are still in flight; skip them.
  let f = await c.readExact(48);
  while (f[0] === 0x43) f = await c.readExact(48);
  assertBytes(f, echoed);
  await sleep(350); // three periods: a still-running timer would send here
  const after = pattern(48, 15);
  await c.writer.write(after);
  assertBytes(await c.readExact(48), after);
  c.close();
  await h.relay.stop();
  await upstream.close();
});

await testAsync('dial fails at session start, upstream appears inside the window', async () => {
  const up = port();
  const h = await startRelay(up);
  const c = await connectClient(h.listenPort);
  const data = pattern(64, 4);
  await c.writer.write(data);
  const reason = await h.holds.next();
  assert.ok(reason.startsWith('connect failed'), reason);
  const upstream = await fakeUpstream(up);
  await h.resumes.next();
  assertBytes(await c.readExact(64), data);
  c.close();
  await h.relay.stop();
  await upstream.close();
});

await testAsync('hold expires: closedBy relay, how hold expired', async () => {
  const up = port();
  const upstream = await fakeUpstream(up);
  const h = await startRelay(up, { holdMs: 400 });
  const c = await connectClient(h.listenPort);
  await c.writer.write(pattern(10, 5));
  await c.readExact(10);
  await upstream.close();
  assert.equal(await c.drain(), 0);
  const s = await h.closes.next();
  assert.equal(s.closedBy, 'relay');
  assert.equal(s.how, 'hold expired');
  assert.ok(s.durationMs >= 400, String(s.durationMs));
  assert.ok(h.lost.all.length >= 1);
  c.close();
  await h.relay.stop();
});

await testAsync('hold buffer over 64 KiB: how hold buffer full', async () => {
  const h = await startRelay(port()); // nothing listens: held from the start
  const c = await connectClient(h.listenPort);
  void c.writer.write(pattern(70 * 1024, 6)).catch(() => {});
  const s = await h.closes.next();
  assert.equal(s.closedBy, 'relay');
  assert.equal(s.how, 'hold buffer full');
  assert.equal(s.bytesUp, 0);
  assert.equal((await c.drain()) >= 0, true);
  c.close();
  await h.relay.stop();
});

await testAsync('holdMs 0 keeps the close behaviour and still reports the loss', async () => {
  const up = port();
  const upstream = await fakeUpstream(up);
  const h = await startRelay(up, { holdMs: 0 });
  const c = await connectClient(h.listenPort);
  await c.writer.write(pattern(10, 7));
  await c.readExact(10);
  await upstream.close();
  assert.equal(await c.drain(), 0);
  await c.writer.close(); // the session waits for the client's FIN, as before
  const s = await h.closes.next();
  assert.equal(s.closedBy, 'D');
  assert.equal(s.how, 'FIN');
  assert.equal((await h.lost.next()).length > 0, true);
  assert.equal(h.holds.all.length, 0);
  c.close();
  await h.relay.stop();
});

await testAsync('holdMs 0 dial failure reports the loss and closes', async () => {
  const h = await startRelay(port(), { holdMs: 0 });
  const c = await connectClient(h.listenPort);
  assert.equal(await c.drain(), 0);
  const s = await h.closes.next();
  assert.equal(s.closedBy, 'relay');
  assert.ok(s.how.startsWith('connect failed'), s.how);
  assert.ok((await h.lost.next()).startsWith('connect failed'));
  c.close();
  await h.relay.stop();
});

await testAsync('client FIN during hold ends the session: closedBy E', async () => {
  const up = port();
  const upstream = await fakeUpstream(up);
  const h = await startRelay(up);
  const c = await connectClient(h.listenPort);
  await c.writer.write(pattern(10, 8));
  await c.readExact(10);
  await upstream.close();
  await h.holds.next();
  await c.writer.close();
  const s = await h.closes.next();
  assert.equal(s.closedBy, 'E');
  assert.equal(s.how, 'FIN');
  assert.equal(await c.drain(), 0);
  assert.equal(h.relay.openSessions(), 0);
  c.close();
  await h.relay.stop();
});

await testAsync('stop() during hold resolves quickly with how=shutdown', async () => {
  const h = await startRelay(port(), { holdMs: 60_000, redialBackoffMs: [30_000] });
  const c = await connectClient(h.listenPort);
  await h.holds.next();
  const t0 = Date.now();
  await within(h.relay.stop(), 1500, 'stop');
  assert.ok(Date.now() - t0 < 1500);
  const s = await h.closes.next();
  assert.equal(s.closedBy, 'relay');
  assert.equal(s.how, 'shutdown');
  assert.equal(await c.drain(), 0);
  c.close();
});

async function hasIpv6Loopback(): Promise<boolean> {
  try {
    const s = await tjs.listen('tcp', '::1', port());
    await s.opened;
    s.close();
    return true;
  } catch {
    return false;
  }
}

// Some CI containers have no ::1; the test needs it (see the note inside).
const ipv6 = await hasIpv6Loopback();
if (!ipv6) console.log('  skip: setRoutePort move test (no IPv6 loopback)');
await testAsync('setRoutePort moves the listener; open sessions stay', async () => {
  if (!ipv6) return;
  const targetOld = port();
  const targetNew = port();
  const upOld = await fakeUpstream(targetOld, '::1');
  const upNew = await fakeUpstream(targetNew, '::1');
  const listenOld = port();
  const relay = new CoraRelay({
    listenHost: HOST,
    targetHost: '::1',
    routes: [{ name: 'main', listenPort: listenOld, targetPort: targetOld }],
  });
  await relay.start();
  const kept = await connectClient(listenOld);
  await kept.writer.write(pattern(8, 9));
  await kept.readExact(8);

  // Listen and target share one number, so the relay binds 127.0.0.1:<n> and dials [::1]:<n>.
  await relay.setRoutePort('main', targetNew);
  let refused = false;
  try {
    (await connectClient(listenOld)).close();
  } catch {
    refused = true;
  }
  assert.equal(refused, true);
  const moved = await connectClient(targetNew);
  const data = pattern(32, 10);
  await moved.writer.write(data);
  assertBytes(await moved.readExact(32), data);
  await kept.writer.write(pattern(8, 11)); // the session opened before the move still works
  await kept.readExact(8);
  assert.equal(relay.openSessions(), 2);

  moved.close();
  kept.close();
  await relay.stop();
  await upOld.close();
  await upNew.close();
});

await testAsync('setRoutePort keeps the old listener when the new bind fails', async () => {
  const up = port();
  const upstream = await fakeUpstream(up);
  const h = await startRelay(up);
  const taken = port();
  const blocker = await tjs.listen('tcp', HOST, taken);
  await blocker.opened;
  let threw = false;
  try {
    await h.relay.setRoutePort('main', taken);
  } catch {
    threw = true;
  }
  assert.equal(threw, true);
  const c = await connectClient(h.listenPort);
  const data = pattern(16, 12);
  await c.writer.write(data);
  assertBytes(await c.readExact(16), data);
  c.close();
  blocker.close();
  await h.relay.stop();
  await upstream.close();
});

summaryExit();
