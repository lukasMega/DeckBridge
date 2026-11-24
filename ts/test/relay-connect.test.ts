import assert from 'tjs:assert';
import { CoraRelay } from '../src/main/relay/relay.js';
import type { RelaySessionClose } from '../src/main/relay/relay.js';
import { testAsync, summaryExit } from './helpers/harness.js';

const HOST = '127.0.0.1';
// TEST-NET-1 (RFC 5737): never answers, so the upstream connect stays pending.
const BLACKHOLE = '192.0.2.1';
// Below 32768: Linux gives 32768-60999 to outgoing sockets, which caused EADDRINUSE.
let nextPort = 21010 + (tjs.pid % 100);
const port = (): number => nextPort++;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timeout: ${what}`)), ms)),
  ]);
}

/** Collects onClose calls; `next()` resolves with the next one. */
function closeCollector(waitMs: number): {
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
      return within(new Promise((r) => waiters.push(r)), waitMs, 'onClose');
    },
  };
}

async function startRelay(
  connectTimeoutMs: number,
  onClose: (s: RelaySessionClose) => void,
): Promise<{ relay: CoraRelay; listenPort: number }> {
  const listenPort = port();
  const relay = new CoraRelay({
    listenHost: HOST,
    targetHost: BLACKHOLE,
    routes: [{ name: 'main', listenPort, targetPort: 5343 }],
    connectTimeoutMs,
    onClose,
  });
  await relay.start();
  return { relay, listenPort };
}

await testAsync('connect timeout closes the session as relay / connect timeout', async () => {
  const col = closeCollector(1500);
  const { relay, listenPort } = await startRelay(300, col.onClose);
  const sock = await tjs.connect('tcp', HOST, listenPort);
  await sock.opened;
  const started = Date.now();
  const close = await col.next();
  console.log(`    outcome after ${Date.now() - started} ms: ${close.how}`);
  assert.equal(close.closedBy, 'relay');
  // No route at all fails fast with "connect failed"; that is fine too.
  assert.ok(
    close.how === 'connect timeout' || close.how.startsWith('connect failed'),
    `unexpected how: ${close.how}`,
  );
  sock.close();
  await within(relay.stop(), 1000, 'stop');
  assert.equal(relay.openSessions(), 0);
});

await testAsync('stop() while the upstream connect is pending does not wait for it', async () => {
  const col = closeCollector(1500);
  const { relay, listenPort } = await startRelay(5000, col.onClose);
  const sock = await tjs.connect('tcp', HOST, listenPort);
  await sock.opened;
  await sleep(100);
  await within(relay.stop(), 1000, 'stop');
  assert.equal(relay.openSessions(), 0);
  const close = await col.next();
  assert.equal(close.closedBy, 'relay');
  sock.close();
});

summaryExit();
