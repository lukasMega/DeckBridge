import assert from 'tjs:assert';
import { CoraRelay } from '../src/main/relay/relay.js';
import {
  CORA_FLAG_ACKNAK,
  CORA_FLAG_REQACK,
  CORA_FLAG_VERBATIM,
  CoraFrameReader,
  encodeCoraFrame,
} from '../src/cora/frame.js';
import type { CoraFrame } from '../src/cora/frame.js';
import { testAsync, summaryExit } from './helpers/harness.js';

const HOST = '127.0.0.1';
// Below 32768: Linux gives 32768-60999 to outgoing sockets, which caused EADDRINUSE.
let nextPort = 21310 + (tjs.pid % 100);
const port = (): number => nextPort++;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timeout: ${what}`)), ms)),
  ]);
}

/** Reads CORA frames from one socket; `raw` lets a test write bytes. */
class Peer {
  readonly frames = new CoraFrameReader();
  private queue: CoraFrame[] = [];
  private pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    readonly writer: WritableStreamDefaultWriter<Uint8Array>,
  ) {}

  async next(ms = 2000): Promise<CoraFrame> {
    while (this.queue.length === 0) {
      // Keep a timed-out read: dropping it would swallow the next chunk.
      this.pending ??= this.reader.read();
      const { done, value } = await within(this.pending, ms, 'frame');
      this.pending = null;
      if (done) throw new Error('EOF');
      this.frames.append(Buffer.wrap(value));
      this.queue.push(...this.frames.drainFrames());
    }
    return this.queue.shift() as CoraFrame;
  }

  /** True when no frame arrives within `ms`. */
  async silent(ms: number): Promise<boolean> {
    try {
      await this.next(ms);
      return false;
    } catch {
      return true;
    }
  }
}

// Output report 0x02, command 0x07 (key image chunk), key 3.
const imageFrame = (id: number, flags = CORA_FLAG_REQACK): Buffer =>
  encodeCoraFrame(Buffer.from([0x02, 0x07, 3, 1, 0, 0, 0, 0]), flags, 1, id);
// Output report 0x02, command 0x05: not an image command.
const otherFrame = (id: number): Buffer =>
  encodeCoraFrame(Buffer.from([0x02, 0x05, 0, 0]), CORA_FLAG_REQACK, 1, id);

interface Upstream {
  conn(): Promise<Peer>;
  close(): void;
}

async function upstream(p: number): Promise<Upstream> {
  const server = await tjs.listen('tcp', HOST, p);
  const accept = (await server.opened).readable.getReader();
  const conns: TjsAcceptedTCPSocket[] = [];
  const peer = (async (): Promise<Peer> => {
    const { value: c } = await accept.read();
    conns.push(c as TjsAcceptedTCPSocket);
    const info = await (c as TjsAcceptedTCPSocket).opened;
    return new Peer(info.readable.getReader(), info.writable.getWriter());
  })();
  return {
    conn: () => peer,
    close(): void {
      server.close();
      for (const c of conns) c.close();
    },
  };
}

async function connectClient(p: number): Promise<{ peer: Peer; close(): void }> {
  const sock = await tjs.connect('tcp', HOST, p);
  const info = await sock.opened;
  return {
    peer: new Peer(info.readable.getReader(), info.writable.getWriter()),
    close: () => sock.close(),
  };
}

/** The relay ACKs only once its upstream is live, so wait for that before the first frame. */
async function live(u: Upstream): Promise<Peer> {
  const p = await u.conn();
  await sleep(100);
  return p;
}

function startRelay(
  target: number,
  ackTerm: boolean,
  holdMs = 3000,
  name: 'main' | 'child' = 'child',
): { relay: CoraRelay; listen: number } {
  const listen = port();
  const relay = new CoraRelay({
    listenHost: HOST,
    targetHost: HOST,
    routes: [{ name, listenPort: listen, targetPort: target }],
    connectTimeoutMs: 1000,
    holdMs,
    redialBackoffMs: [50],
    holdKeepaliveMs: 0,
    ackTerm,
  });
  return { relay, listen };
}

await testAsync(
  'ack-term on: image ACK comes from the relay, REQACK is cleared upstream',
  async () => {
    const up = port();
    const u = await upstream(up);
    const { relay, listen } = startRelay(up, true);
    await relay.start();
    const c = await connectClient(listen);
    const upPeer = await live(u);
    await c.peer.writer.write(imageFrame(77));
    const ack = await c.peer.next(); // upstream never answers, so this is the relay's
    assert.equal(ack.messageId, 77);
    assert.equal(ack.hidOp, 1);
    assert.equal(ack.flags, CORA_FLAG_VERBATIM | CORA_FLAG_ACKNAK);
    const d = await upPeer.next();
    assert.equal(d.messageId, 77);
    assert.equal(d.flags & CORA_FLAG_REQACK, 0);
    assert.equal(d.payload[1], 0x07);
    c.close();
    await relay.stop();
    u.close();
  },
);

await testAsync('ack-term on: non-image frames and frames split across writes', async () => {
  const up = port();
  const u = await upstream(up);
  const { relay, listen } = startRelay(up, true);
  await relay.start();
  const c = await connectClient(listen);
  const upPeer = await live(u);
  await c.peer.writer.write(otherFrame(5));
  assert.equal(await c.peer.silent(200), true); // no local ACK for a non-image command
  assert.equal((await upPeer.next()).flags, CORA_FLAG_REQACK); // forwarded untouched
  const f = imageFrame(6);
  await c.peer.writer.write(f.subarray(0, 10)); // cut inside the header
  assert.equal(await c.peer.silent(100), true);
  await c.peer.writer.write(f.subarray(10));
  assert.equal((await c.peer.next()).messageId, 6);
  c.close();
  await relay.stop();
  u.close();
});

await testAsync('ack-term on: a down frame cut in two never has an ACK inside it', async () => {
  const up = port();
  const u = await upstream(up);
  const { relay, listen } = startRelay(up, true);
  await relay.start();
  const c = await connectClient(listen);
  const upPeer = await live(u);
  await c.peer.writer.write(otherFrame(1));
  await upPeer.next();
  const down = encodeCoraFrame(Buffer.alloc(32, 0xab), 0, 0, 9);
  await upPeer.writer.write(down.subarray(0, 20));
  await sleep(50);
  await c.peer.writer.write(imageFrame(2));
  assert.equal((await c.peer.next()).messageId, 2); // the ACK, whole
  await upPeer.writer.write(down.subarray(20));
  const got = await c.peer.next();
  assert.equal(got.messageId, 9);
  assert.equal(got.payload.length, 32);
  c.close();
  await relay.stop();
  u.close();
});

await testAsync('ack-term off: no local ACK, REQACK reaches DeckBridge unchanged', async () => {
  const up = port();
  const u = await upstream(up);
  const { relay, listen } = startRelay(up, false);
  await relay.start();
  const c = await connectClient(listen);
  await c.peer.writer.write(imageFrame(8));
  assert.equal(await c.peer.silent(200), true);
  const d = await (await u.conn()).next();
  assert.equal(d.flags, CORA_FLAG_REQACK);
  c.close();
  await relay.stop();
  u.close();
});

await testAsync(
  'ack-term on while upstream is away: no local ACK, REQACK kept for replay',
  async () => {
    const up = port(); // nothing listens yet: held from the start
    const { relay, listen } = startRelay(up, true);
    await relay.start();
    const c = await connectClient(listen);
    await c.peer.writer.write(imageFrame(11));
    assert.equal(await c.peer.silent(250), true);
    const u = await upstream(up);
    const d = await (await u.conn()).next(3000);
    assert.equal(d.messageId, 11);
    assert.equal(d.flags, CORA_FLAG_REQACK); // DeckBridge ACKs this one itself
    c.close();
    await relay.stop();
    u.close();
  },
);

await testAsync(
  'ack-term on, main route: left alone (images only use the child route)',
  async () => {
    const up = port();
    const u = await upstream(up);
    const { relay, listen } = startRelay(up, true, 3000, 'main');
    await relay.start();
    const c = await connectClient(listen);
    const upPeer = await live(u);
    await c.peer.writer.write(imageFrame(12));
    assert.equal(await c.peer.silent(200), true);
    assert.equal((await upPeer.next()).flags, CORA_FLAG_REQACK);
    c.close();
    await relay.stop();
    u.close();
  },
);

summaryExit();
