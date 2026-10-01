import assert from 'tjs:assert';
import { PluginHost, listPluginFiles, pluginKeyStatus } from '../src/plugin/plugin-host.js';
import type { WorkerLike } from '../src/plugin/plugin-host.js';
import type {
  MainToPluginWorker,
  PluginWorkerToMain,
} from '../src/plugin/plugin-worker-protocol.js';
import pluginWorkerSource from 'virtual:plugin-worker';
import { spawnWorker } from '../src/shared/worker-lifecycle.js';
import { testAsync as runTest, summaryExit } from './helpers/harness.js';

const macrotask = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const KEY = 'p.js\0';
const PLUGINS_DIR = `${tjs.tmpDir}/plugin-host-plugins`;
// http:// on purpose — the ctx.fetch proxy is http-only (no TLS in the slim build).
// eslint-disable-next-line sonarjs/no-clear-text-protocols
const HTTP_URL = 'http://example/x';

/** Worker stub: records what the host posts and lets the test push messages back. */
class FakeWorker implements WorkerLike {
  posted: MainToPluginWorker[] = [];
  terminated = false;
  private msgCbs: Array<(ev: MessageEvent) => void> = [];
  private errCbs: Array<(ev: MessageEvent) => void> = [];

  postMessage(msg: MainToPluginWorker): void {
    this.posted.push(msg);
  }
  terminate(): void {
    this.terminated = true;
  }
  addEventListener(type: 'message' | 'error', listener: (ev: MessageEvent) => void): void {
    (type === 'message' ? this.msgCbs : this.errCbs).push(listener);
  }
  // test drivers
  emit(msg: PluginWorkerToMain): void {
    for (const cb of this.msgCbs) cb({ data: msg } as unknown as MessageEvent);
  }
  emitError(message: string): void {
    for (const cb of this.errCbs) cb({ message } as unknown as MessageEvent);
  }
  configures(): Extract<MainToPluginWorker, { type: 'configure' }>[] {
    return this.posted.filter(
      (m): m is Extract<MainToPluginWorker, { type: 'configure' }> => m.type === 'configure',
    );
  }
}

interface Priv {
  hbTick(): void;
  entries: Map<string, { lastRequested: number; status: string }>;
  worker: FakeWorker | null;
}
const priv = (h: PluginHost): Priv => h as unknown as Priv;

/** A host whose factory hands out (and remembers) FakeWorkers. */
function makeHost(): { host: PluginHost; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const host = new PluginHost({
    pluginsDir: PLUGINS_DIR,
    workerFactory: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
  });
  return { host, workers };
}

// protocol shapes

console.log('\nplugin-worker-protocol');

await runTest('configure/value/fetch/pong message shapes round-trip', () => {
  const cfg: MainToPluginWorker = {
    type: 'configure',
    plugins: [{ key: 'a\0x', path: `${PLUGINS_DIR}/a.js`, param: 'x', intervalMs: 30_000, gen: 1 }],
  };
  assert.equal(cfg.type, 'configure');
  assert.equal(cfg.plugins[0]!.path, `${PLUGINS_DIR}/a.js`);

  const value: PluginWorkerToMain = { type: 'value', key: 'k', value: 'hi' };
  const cleared: PluginWorkerToMain = { type: 'value', key: 'k', value: null };
  assert.equal(value.value, 'hi');
  assert.equal(cleared.value, null);

  const fetchReq: PluginWorkerToMain = {
    type: 'fetch',
    fetchId: 7,
    key: 'k',
    gen: 1,
    url: HTTP_URL,
  };
  const fetchRes: MainToPluginWorker = {
    type: 'fetchResult',
    fetchId: 7,
    ok: true,
    status: 200,
    body: '{}',
  };
  assert.equal(fetchReq.fetchId, fetchRes.fetchId);
});

// request / value cache

console.log('\nPluginHost.request');

await runTest('first request starts the worker and pushes configure', () => {
  const { host, workers } = makeHost();
  const before = host.request('p.js', undefined, undefined, () => {});
  assert.equal(before.status, 'pending');
  assert.equal(before.value, undefined);
  assert.equal(workers.length, 1, 'one worker spawned');
  assert.equal(workers[0]!.configures().length, 1, 'configure pushed');
  assert.equal(workers[0]!.configures()[0]!.plugins.length, 1);
  host.stop();
});

await runTest('a value message caches + repaints; re-request returns it', () => {
  const { host, workers } = makeHost();
  let repaints = 0;
  host.request('p.js', 'AAPL', undefined, () => repaints++);
  const key = workers[0]!.configures()[0]!.plugins[0]!.key;
  workers[0]!.emit({ type: 'value', key, value: '42' });
  assert.equal(repaints, 1, 'onUpdate fired');
  const now = host.request('p.js', 'AAPL', undefined, () => {});
  assert.equal(now.value, '42');
  assert.equal(now.status, 'ok');
  host.stop();
});

await runTest(
  'bare file name resolves against the plugins dir; absolute path passes through',
  () => {
    const { host, workers } = makeHost();
    host.request('p.js', undefined, undefined, () => {});
    host.request('/somewhere/else/q.js', undefined, undefined, () => {});
    const plugins = workers[0]!.configures().at(-1)!.plugins;
    assert.equal(
      plugins.find((p) => p.param === '' && p.path.endsWith('p.js'))!.path,
      `${PLUGINS_DIR}/p.js`,
    );
    assert.equal(plugins.find((p) => p.path.endsWith('q.js'))!.path, '/somewhere/else/q.js');
    host.stop();
  },
);

await runTest('unchanged re-request does not re-push configure', () => {
  const { host, workers } = makeHost();
  host.request('p.js', 'x', 30_000, () => {});
  host.request('p.js', 'x', 30_000, () => {});
  host.request('p.js', 'x', 30_000, () => {});
  assert.equal(workers[0]!.configures().length, 1, 'configure pushed once');
  host.stop();
});

await runTest('an error message marks the key ERR', () => {
  const { host, workers } = makeHost();
  host.request('p.js', undefined, undefined, () => {});
  const key = workers[0]!.configures()[0]!.plugins[0]!.key;
  workers[0]!.emit({ type: 'error', key, message: 'boom' });
  assert.equal(host.statusOf('p.js'), 'err');
  host.stop();
});

// ctx.fetch proxy (runs on the host/main thread)

console.log('\nPluginHost fetch proxy');

await runTest('plaintext fetch request → main-thread fetch → fetchResult', async () => {
  const realFetch = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = (url: string) =>
    Promise.resolve(new Response(`body:${url}`, { status: 200 }));
  try {
    const { host, workers } = makeHost();
    host.request('p.js', undefined, undefined, () => {});
    workers[0]!.emit({ type: 'fetch', fetchId: 1, key: KEY, gen: 1, url: HTTP_URL });
    await macrotask();
    const res = workers[0]!.posted.find((m) => m.type === 'fetchResult');
    assert.ok(res, 'fetchResult posted');
    assert.equal((res as { ok: boolean }).ok, true);
    assert.equal((res as { body: string }).body, `body:${HTTP_URL}`);
    host.stop();
  } finally {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  }
});

await runTest('non-http url is rejected without calling fetch', async () => {
  const { host, workers } = makeHost();
  host.request('p.js', undefined, undefined, () => {});
  workers[0]!.emit({ type: 'fetch', fetchId: 2, key: KEY, gen: 1, url: 'https://example/x' });
  await macrotask();
  const res = workers[0]!.posted.find((m) => m.type === 'fetchResult') as
    | { ok: boolean; error?: string }
    | undefined;
  assert.ok(res, 'fetchResult posted');
  assert.equal(res!.ok, false);
  assert.ok((res!.error ?? '').includes('TLS'), 'error explains the no-TLS limitation');
  host.stop();
});

type FetchCall = { url: string; signal: AbortSignal; body?: string };

/** Swap the global fetch for `impl` while `fn` runs. */
async function withFetch(
  impl: (call: FetchCall) => Promise<Response>,
  fn: (calls: FetchCall[]) => Promise<void>,
): Promise<void> {
  const realFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  (globalThis as { fetch: unknown }).fetch = (url: string, init: RequestInit) => {
    const call = { url, signal: init.signal!, body: init.body as string | undefined };
    calls.push(call);
    return impl(call);
  };
  try {
    await fn(calls);
  } finally {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  }
}

/** Resolves with nothing until the request's signal aborts, then rejects like txiki. */
const untilAborted = (signal: AbortSignal): Promise<never> =>
  new Promise((_, reject) =>
    signal.addEventListener('abort', () => reject(new Error('AbortError')), { once: true }),
  );

type FetchResult = Extract<MainToPluginWorker, { type: 'fetchResult' }>;
const results = (w: FakeWorker): FetchResult[] =>
  w.posted.filter((m): m is FetchResult => m.type === 'fetchResult');

async function waitForResult(w: FakeWorker, fetchId: number, ms = 1000): Promise<FetchResult> {
  const deadline = Date.now() + ms;
  for (;;) {
    const r = results(w).find((m) => m.fetchId === fetchId);
    if (r) return r;
    if (Date.now() > deadline) throw new Error(`no fetchResult for ${fetchId}`);
    await sleepMs(5);
  }
}

function hostWithTimeout(ms: number): { host: PluginHost; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const host = new PluginHost({
    pluginsDir: PLUGINS_DIR,
    fetchTimeoutMs: ms,
    workerFactory: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
  });
  return { host, workers };
}

await runTest('stalled headers: the deadline aborts the request itself', async () => {
  await withFetch(
    (c) => untilAborted(c.signal),
    async (calls) => {
      const { host, workers } = hostWithTimeout(40);
      host.request('p.js', undefined, undefined, () => {});
      workers[0]!.emit({ type: 'fetch', fetchId: 1, key: KEY, gen: 1, url: HTTP_URL });
      const r = await waitForResult(workers[0]!, 1);
      assert.equal(r.error, 'fetch timeout');
      assert.ok(calls[0]!.signal.aborted, 'native request aborted, not just raced');
      assert.equal(host.activeFetchCount, 0);
      host.stop();
    },
  );
});

await runTest('headers arrive, body stalls: the original deadline still fires', async () => {
  let cancelled = false;
  await withFetch(
    () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode('partial'));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
      ),
    async () => {
      const { host, workers } = hostWithTimeout(60);
      host.request('p.js', undefined, undefined, () => {});
      workers[0]!.emit({ type: 'fetch', fetchId: 1, key: KEY, gen: 1, url: HTTP_URL });
      const r = await waitForResult(workers[0]!, 1);
      assert.equal(r.error, 'fetch timeout');
      assert.equal(r.body, '', 'no partial body on failure');
      assert.ok(cancelled, 'body stream cancelled');
      host.stop();
    },
  );
});

await runTest('a slow trickle never resets the deadline', async () => {
  let timer: ReturnType<typeof setInterval> | undefined;
  await withFetch(
    () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              timer = setInterval(() => c.enqueue(new Uint8Array([0x61])), 10);
            },
            cancel() {
              clearInterval(timer);
            },
          }),
        ),
      ),
    async () => {
      const { host, workers } = hostWithTimeout(80);
      host.request('p.js', undefined, undefined, () => {});
      const t0 = Date.now();
      workers[0]!.emit({ type: 'fetch', fetchId: 1, key: KEY, gen: 1, url: HTTP_URL });
      const r = await waitForResult(workers[0]!, 1);
      assert.equal(r.error, 'fetch timeout');
      assert.ok(Date.now() - t0 < 500);
      host.stop();
    },
  );
  clearInterval(timer);
});

await runTest('unknown-length body over 1 MiB fails while streaming', async () => {
  let pulled = 0;
  let cancelled = false;
  await withFetch(
    () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull(c) {
              pulled++;
              c.enqueue(new Uint8Array(64 * 1024));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
      ),
    async () => {
      const { host, workers } = hostWithTimeout(5000);
      host.request('p.js', undefined, undefined, () => {});
      workers[0]!.emit({ type: 'fetch', fetchId: 1, key: KEY, gen: 1, url: HTTP_URL });
      const r = await waitForResult(workers[0]!, 1);
      assert.ok(r.error?.includes('response exceeds'), r.error);
      assert.ok(cancelled);
      assert.ok(pulled <= 20, `stopped near the cap (pulled ${pulled} chunks)`);
      host.stop();
    },
  );
});

await runTest('declared oversized body is refused before reading it', async () => {
  let pulled = 0;
  await withFetch(
    () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull(c) {
              pulled++;
              c.enqueue(new Uint8Array(1));
            },
          }),
          { headers: { 'content-length': String(8 * 1024 * 1024) } },
        ),
      ),
    async (calls) => {
      const { host, workers } = hostWithTimeout(5000);
      host.request('p.js', undefined, undefined, () => {});
      workers[0]!.emit({ type: 'fetch', fetchId: 1, key: KEY, gen: 1, url: HTTP_URL });
      const r = await waitForResult(workers[0]!, 1);
      assert.ok(r.error?.includes('response exceeds'), r.error);
      assert.ok(calls[0]!.signal.aborted);
      assert.ok(pulled <= 1, `body barely touched (pulled ${pulled})`);
      host.stop();
    },
  );
});

await runTest('a fifth simultaneous request fails at once (no queue)', async () => {
  await withFetch(
    (c) => untilAborted(c.signal),
    async (calls) => {
      const { host, workers } = hostWithTimeout(5000);
      host.request('p.js', undefined, undefined, () => {});
      for (let id = 1; id <= 5; id++) {
        workers[0]!.emit({ type: 'fetch', fetchId: id, key: KEY, gen: 1, url: HTTP_URL });
      }
      const r = await waitForResult(workers[0]!, 5);
      assert.ok(r.error?.includes('too many concurrent'), r.error);
      assert.equal(calls.length, 4, 'the fifth never reached fetch');
      assert.equal(host.activeFetchCount, 4);
      host.stop();
      assert.equal(host.activeFetchCount, 0);
      assert.ok(calls.every((c) => c.signal.aborted));
    },
  );
});

await runTest('oversized request body is refused before fetch', async () => {
  await withFetch(
    () => Promise.resolve(new Response('')),
    async (calls) => {
      const { host, workers } = hostWithTimeout(5000);
      host.request('p.js', undefined, undefined, () => {});
      const body = 'x'.repeat(1024 * 1024 + 1);
      workers[0]!.emit({
        type: 'fetch',
        fetchId: 1,
        key: KEY,
        gen: 1,
        url: HTTP_URL,
        init: { body },
      });
      const r = await waitForResult(workers[0]!, 1);
      assert.ok(r.error?.includes('request body exceeds'), r.error);
      assert.equal(calls.length, 0);
      host.stop();
    },
  );
});

await runTest('HTTP error status and multibyte body survive within limits', async () => {
  const bytes = new TextEncoder().encode('é!');
  await withFetch(
    () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              // Split the two-byte é across chunks.
              c.enqueue(bytes.slice(0, 1));
              c.enqueue(bytes.slice(1));
              c.close();
            },
          }),
          { status: 503 },
        ),
      ),
    async () => {
      const { host, workers } = hostWithTimeout(5000);
      host.request('p.js', undefined, undefined, () => {});
      workers[0]!.emit({ type: 'fetch', fetchId: 1, key: KEY, gen: 1, url: HTTP_URL });
      const r = await waitForResult(workers[0]!, 1);
      assert.equal(r.ok, false);
      assert.equal(r.status, 503);
      assert.equal(r.body, 'é!');
      assert.equal(r.error, undefined);
      host.stop();
    },
  );
});

await runTest('removing a plugin cancels only its own requests', async () => {
  await withFetch(
    (c) => untilAborted(c.signal),
    async (calls) => {
      const { host, workers } = hostWithTimeout(5000);
      host.request('a.js', undefined, undefined, () => {});
      host.request('b.js', undefined, undefined, () => {});
      workers[0]!.emit({ type: 'fetch', fetchId: 1, key: 'a.js\0', gen: 1, url: HTTP_URL });
      workers[0]!.emit({ type: 'fetch', fetchId: 2, key: 'b.js\0', gen: 2, url: HTTP_URL });
      priv(host).entries.get('a.js\0')!.lastRequested = 0;
      priv(host).hbTick(); // reaps the stale key
      const r = await waitForResult(workers[0]!, 1);
      assert.equal(r.error, 'plugin removed');
      assert.ok(calls[0]!.signal.aborted);
      assert.ok(!calls[1]!.signal.aborted, 'the other plugin keeps its request');
      host.stop();
    },
  );
});

await runTest('a respawned worker never receives the old worker’s result', async () => {
  const pending: Array<(r: Response) => void> = [];
  await withFetch(
    () => new Promise<Response>((resolve) => pending.push(resolve)),
    async (calls) => {
      const { host, workers } = hostWithTimeout(5000);
      host.request('p.js', undefined, undefined, () => {});
      workers[0]!.emit({ type: 'fetch', fetchId: 1, key: KEY, gen: 1, url: HTTP_URL });
      workers[0]!.emitError('boom'); // respawn
      assert.ok(calls[0]!.signal.aborted, 'old request aborted with its worker');
      workers[0]!.emit({ type: 'fetch', fetchId: 9, key: KEY, gen: 1, url: HTTP_URL }); // stale sender
      workers[1]!.emit({ type: 'fetch', fetchId: 1, key: KEY, gen: 1, url: HTTP_URL }); // same id
      assert.equal(calls.length, 2, 'the stale worker’s message was ignored');
      pending[0]!(new Response('old'));
      pending[1]!(new Response('new'));
      const r = await waitForResult(workers[1]!, 1);
      assert.equal(r.body, 'new');
      await sleepMs(10);
      assert.equal(results(workers[1]!).length, 1, 'exactly one result for the new worker');
      assert.equal(results(workers[0]!).length, 0);
      host.stop();
    },
  );
});

await runTest('dispose aborts every request, settles, and never respawns', async () => {
  await withFetch(
    (c) => untilAborted(c.signal),
    async (calls) => {
      const { host, workers } = hostWithTimeout(5000);
      host.request('p.js', undefined, undefined, () => {});
      workers[0]!.emit({ type: 'fetch', fetchId: 1, key: KEY, gen: 1, url: HTTP_URL });
      await host.dispose();
      assert.ok(calls[0]!.signal.aborted);
      assert.equal(host.activeFetchCount, 0);
      assert.ok(workers[0]!.terminated || priv(host).worker === null);
      const v = host.request('q.js', undefined, undefined, () => {});
      assert.equal(v.status, 'pending');
      assert.equal(workers.length, 1, 'no worker spawned after dispose');
    },
  );
});

await runTest('native loopback: a stalled body is aborted and the connection closed', async () => {
  const port = 47900 + (tjs.pid % 50);
  const server = await tjs.listen('tcp', '127.0.0.1', port);
  const { readable } = await server.opened;
  const accepts = readable.getReader();
  let hungUp = false;
  const peerClosed = (async (): Promise<void> => {
    const { value: conn } = await accepts.read();
    const io = await conn!.opened;
    const w = io.writable.getWriter();
    const r = io.readable.getReader();
    await r.read(); // request
    await w.write(
      new TextEncoder().encode('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npartial'),
    );
    // Wait for the client to hang up (EOF or reset) — the abort must reach the socket.
    try {
      while (!(await r.read()).done);
    } catch {
      // reset also counts as a hang-up
    }
    hungUp = true;
  })();
  const { host, workers } = hostWithTimeout(150);
  host.request('p.js', undefined, undefined, () => {});
  workers[0]!.emit({
    type: 'fetch',
    fetchId: 1,
    key: KEY,
    gen: 1,
    url: `http://127.0.0.1:${port}/`,
  });
  const r = await waitForResult(workers[0]!, 1, 3000);
  assert.equal(r.error, 'fetch timeout');
  await Promise.race([peerClosed, sleepMs(2000)]);
  assert.ok(hungUp, 'server saw the connection close');
  host.stop();
  accepts.releaseLock();
  server.close();
});

await runTest('removed key with a surviving peer: zero new HTTP, no admission', async () => {
  await withFetch(
    (c) => untilAborted(c.signal),
    async (calls) => {
      const { host, workers } = hostWithTimeout(5000);
      host.request('a.js', undefined, undefined, () => {});
      host.request('b.js', undefined, undefined, () => {});
      priv(host).entries.get('a.js\0')!.lastRequested = 0;
      priv(host).hbTick(); // reaps a; b keeps the worker alive
      assert.ok(!workers[0]!.terminated, 'worker survives');
      for (let id = 1; id <= 6; id++) {
        workers[0]!.emit({ type: 'fetch', fetchId: id, key: 'a.js\0', gen: 1, url: HTTP_URL });
      }
      assert.equal(calls.length, 0, 'no HTTP for the removed key');
      assert.equal(host.activeFetchCount, 0, 'nothing allocated');
      assert.equal(results(workers[0]!).length, 6, 'each refused at once');
      assert.equal(results(workers[0]!)[0]!.error, 'plugin removed');
      // The peer still gets the whole shared concurrency.
      for (let id = 10; id < 14; id++) {
        workers[0]!.emit({ type: 'fetch', fetchId: id, key: 'b.js\0', gen: 2, url: HTTP_URL });
      }
      assert.equal(calls.length, 4);
      assert.equal(host.activeFetchCount, 4);
      host.stop();
      await host.dispose();
      assert.equal(host.activeFetchCount, 0);
    },
  );
});

await runTest('disabled key: immediate rejection, no request', async () => {
  await withFetch(
    (c) => untilAborted(c.signal),
    async (calls) => {
      const { host, workers } = hostWithTimeout(5000);
      host.request('p.js', undefined, undefined, () => {});
      host.request('q.js', undefined, undefined, () => {});
      priv(host).entries.get(KEY)!.status = 'disabled';
      workers[0]!.emit({ type: 'fetch', fetchId: 1, key: KEY, gen: 1, url: HTTP_URL });
      assert.equal(results(workers[0]!)[0]!.error, 'plugin disabled');
      assert.equal(calls.length, 0);
      assert.equal(host.activeFetchCount, 0);
      host.stop();
    },
  );
});

await runTest('removed then re-added key: the old poll stays rejected', async () => {
  await withFetch(
    (c) => untilAborted(c.signal),
    async (calls) => {
      const { host, workers } = hostWithTimeout(5000);
      host.request('a.js', undefined, undefined, () => {});
      host.request('b.js', undefined, undefined, () => {});
      priv(host).entries.get('a.js\0')!.lastRequested = 0;
      priv(host).hbTick();
      host.request('a.js', undefined, undefined, () => {}); // re-added: new generation
      const cfg = workers[0]!
        .configures()
        .at(-1)!
        .plugins.find((p) => p.key === 'a.js\0')!;
      assert.notEqual(cfg.gen, 1, 'new poll identity');
      workers[0]!.emit({ type: 'fetch', fetchId: 1, key: 'a.js\0', gen: 1, url: HTTP_URL });
      assert.equal(calls.length, 0, 'old poll refused');
      assert.equal(results(workers[0]!)[0]!.error, 'plugin removed');
      workers[0]!.emit({ type: 'fetch', fetchId: 2, key: 'a.js\0', gen: cfg.gen, url: HTTP_URL });
      assert.equal(calls.length, 1, 'new poll admitted');
      host.stop();
    },
  );
});

await runTest('removal during body read cancels the reader and settles', async () => {
  let cancelled = false;
  await withFetch(
    () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode('partial'));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
      ),
    async () => {
      const { host, workers } = hostWithTimeout(5000);
      host.request('a.js', undefined, undefined, () => {});
      host.request('b.js', undefined, undefined, () => {});
      workers[0]!.emit({ type: 'fetch', fetchId: 1, key: 'a.js\0', gen: 1, url: HTTP_URL });
      await sleepMs(20); // headers in, body stalled
      priv(host).entries.get('a.js\0')!.lastRequested = 0;
      priv(host).hbTick();
      const r = await waitForResult(workers[0]!, 1);
      assert.equal(r.error, 'plugin removed');
      assert.ok(cancelled, 'reader cancelled');
      assert.equal(host.activeFetchCount, 0);
      host.stop();
    },
  );
});

await runTest('real worker: a cancelled poll’s ctx.fetch rejects before posting', async () => {
  await tjs.makeDir(PLUGINS_DIR, { recursive: true }).catch(() => undefined);
  await tjs.writeFile(
    `${PLUGINS_DIR}/late.js`,
    `export default { async fetch(ctx) {
      setTimeout(async () => {
        try { await ctx.fetch('http://example/x'); ctx.log('late-ok'); }
        catch (e) { ctx.log('late-rejected:' + e.message); }
      }, 400);
      return 'v';
    } };`,
  );
  await tjs.writeFile(
    `${PLUGINS_DIR}/peer.js`,
    `export default { async fetch() { return 'p'; } };`,
  );
  const seen: PluginWorkerToMain[] = [];
  const host = new PluginHost({
    pluginsDir: PLUGINS_DIR,
    workerFactory: () => {
      const { worker: w } = spawnWorker(pluginWorkerSource);
      w.addEventListener('message', (e: MessageEvent) => seen.push(e.data as PluginWorkerToMain));
      return {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker.postMessage takes no targetOrigin
        postMessage: (m) => w.postMessage(m),
        terminate: () => w.terminate(),
        addEventListener: (t, l) => w.addEventListener(t, l as EventListener),
      };
    },
  });
  host.request('late.js', undefined, undefined, () => {});
  host.request('peer.js', undefined, undefined, () => {});
  await sleepMs(250); // poll ran; its timer is armed
  priv(host).entries.get('late.js\0')!.lastRequested = 0;
  host.request('peer.js', undefined, undefined, () => {});
  priv(host).hbTick(); // late.js removed, peer keeps the worker
  await sleepMs(500);
  const logs = seen.filter((m) => m.type === 'log').map((m) => (m as { message: string }).message);
  assert.ok(logs.includes('late-rejected:plugin removed'), `logs: ${logs.join('|')}`);
  assert.equal(seen.filter((m) => m.type === 'fetch').length, 0, 'nothing posted');
  host.stop();
});

// heartbeat watchdog

console.log('\nPluginHost watchdog');

await runTest('missed pongs terminate + respawn the worker, re-pushing config', async () => {
  const { host, workers } = makeHost();
  host.request('p.js', undefined, undefined, () => {});
  const p = priv(host);
  p.hbTick(); // ping
  p.hbTick(); // missed 1
  p.hbTick(); // missed 2 → dead → respawn
  await macrotask(); // deferred terminate runs
  assert.ok(workers[0]!.terminated, 'first worker terminated');
  assert.equal(workers.length, 2, 'a fresh worker was spawned');
  assert.equal(workers[1]!.configures().length, 1, 'config re-pushed to the new worker');
  host.stop();
});

await runTest('a pong resets the miss counter (no respawn)', () => {
  const { host, workers } = makeHost();
  host.request('p.js', undefined, undefined, () => {});
  const p = priv(host);
  p.hbTick(); // ping seq 1
  workers[0]!.emit({ type: 'pong', seq: 1 });
  p.hbTick(); // awaitingPong was cleared → no miss
  p.hbTick();
  assert.equal(workers.length, 1, 'no respawn while ponging');
  host.stop();
});

await runTest('3 consecutive kills disable the plugins until config change', async () => {
  const { host, workers } = makeHost();
  let repaints = 0;
  host.request('p.js', undefined, undefined, () => repaints++);
  const p = priv(host);
  for (let i = 0; i < 9; i++) p.hbTick(); // 3 kills (3 ticks each)
  await macrotask();
  assert.equal(host.statusOf('p.js'), 'disabled', 'plugin disabled after 3 kills');
  assert.ok(repaints > 0, 'disable repainted the key');
  assert.equal(p.worker, null, 'worker stopped while disabled');

  // A config change (different interval) re-enables + respawns.
  const spawnsBefore = workers.length;
  const v = host.request('p.js', undefined, 30_000, () => {});
  assert.equal(v.status, 'pending', 're-enabled to pending');
  assert.ok(workers.length > spawnsBefore, 'a fresh worker was spawned on config change');
  host.stop();
});

// reaping

console.log('\nPluginHost reap');

await runTest('a key not re-requested is reaped; last one gone → worker stops', async () => {
  const { host } = makeHost();
  host.request('p.js', undefined, undefined, () => {});
  const p = priv(host);
  for (const e of p.entries.values()) e.lastRequested = Date.now() - 60_000;
  p.hbTick(); // reap → active empty → stop
  await macrotask();
  assert.equal(p.entries.size, 0, 'stale entry dropped');
  assert.equal(p.worker, null, 'worker stopped when no plugins remain');
  host.stop();
});

// forced refresh (tap to refresh)

console.log('\nPluginHost.forceRefresh');

const runNows = (w: FakeWorker): string[] =>
  w.posted.flatMap((m) => (m.type === 'runNow' ? [m.key] : []));

await runTest('force posts one runNow; repeats before the forced poll reports collapse', () => {
  const { host, workers } = makeHost();
  host.request('p.js', 'x', undefined, () => {});
  const key = workers[0]!.configures()[0]!.plugins[0]!.key;
  let settled = 0;
  assert.equal(
    host.forceRefresh('p.js', 'x', () => settled++),
    true,
  );
  host.forceRefresh('p.js', 'x', () => settled++);
  host.forceRefresh('p.js', 'x');
  assert.deepEqual(runNows(workers[0]!), [key], 'one runNow for three taps');
  workers[0]!.emit({ type: 'value', key, value: 'routine' });
  assert.equal(settled, 0, 'a routine poll does not end the refresh');
  workers[0]!.emit({ type: 'value', key, value: 'fresh', forced: true });
  assert.equal(settled, 2, 'every waiter settled once');
  host.forceRefresh('p.js', 'x');
  assert.equal(runNows(workers[0]!).length, 2, 'a later tap posts again');
  host.stop();
});

await runTest('a forced poll that throws still ends the refresh (ERR shown)', () => {
  const { host, workers } = makeHost();
  host.request('p.js', undefined, undefined, () => {});
  const key = workers[0]!.configures()[0]!.plugins[0]!.key;
  let settled = 0;
  host.forceRefresh('p.js', undefined, () => settled++);
  workers[0]!.emit({ type: 'error', key, message: 'boom', forced: true });
  assert.equal(settled, 1);
  assert.equal(host.statusOf('p.js'), 'err');
  host.stop();
});

await runTest('unrequested / blank keys are not refreshable', () => {
  const { host, workers } = makeHost();
  assert.equal(host.forceRefresh('never.js', undefined), false);
  assert.equal(host.forceRefresh('  ', undefined), false);
  assert.equal(workers.length, 0, 'no worker spawned for a force');
});

await runTest('a worker death settles pending refreshes and lets the next tap post', async () => {
  const { host, workers } = makeHost();
  host.request('p.js', undefined, undefined, () => {});
  let settled = 0;
  host.forceRefresh('p.js', undefined, () => settled++);
  workers[0]!.emitError('crash');
  await macrotask();
  assert.equal(settled, 1, 'settled on death');
  host.forceRefresh('p.js', undefined);
  assert.equal(runNows(workers[1]!).length, 1, 'the respawned worker gets a runNow');
  host.stop();
});

await runTest('real worker: a forced key polls now, not at its 60 s interval', async () => {
  const dir = `${tjs.tmpDir}/plugin-host-force-${tjs.pid}`;
  await tjs.makeDir(dir, { recursive: true });
  await tjs.writeFile(
    `${dir}/count.js`,
    'let n = 0;\nexport default { interval: 60000, async fetch() { n++; return String(n); } };\n',
  );
  const host = new PluginHost({ pluginsDir: dir });
  const values: Array<string | null | undefined> = [];
  const poll = (): void => {
    values.push(host.request('count.js', undefined, undefined, poll).value);
  };
  try {
    poll();
    for (let i = 0; i < 100 && !values.includes('1'); i++) await sleepMs(20);
    assert.ok(values.includes('1'), 'first poll reported');
    const force = { settled: false };
    host.forceRefresh('count.js', undefined, () => (force.settled = true));
    host.forceRefresh('count.js', undefined);
    for (let i = 0; i < 100 && !force.settled; i++) await sleepMs(20);
    assert.ok(force.settled, 'forced poll reported');
    await sleepMs(100);
    assert.ok(values.includes('2'), 'second poll ran long before the interval');
    assert.ok(!values.includes('3'), 'repeated forces collapsed into one poll');
  } finally {
    host.stop();
    await tjs.remove(dir, { recursive: true });
  }
});

// listPluginFiles

console.log('\nlistPluginFiles');

await runTest('lists only *.js, sorted; missing dir → []', async () => {
  const dir = `${tjs.tmpDir}/plugin-host-test-${tjs.pid}`;
  await tjs.makeDir(dir, { recursive: true });
  await tjs.writeFile(`${dir}/b.js`, 'export default {}');
  await tjs.writeFile(`${dir}/a.js`, 'export default {}');
  await tjs.writeFile(`${dir}/notes.txt`, 'x');
  assert.deepEqual(await listPluginFiles(dir), ['a.js', 'b.js']);
  assert.deepEqual(await listPluginFiles(`${dir}/does-not-exist`), []);
  await tjs.remove(dir, { recursive: true });
});

console.log('\npluginKeyStatus');

await runTest('an unconfigured key reports pending (singleton WebUI API)', () => {
  assert.equal(pluginKeyStatus('never-configured.js'), 'pending');
  assert.equal(pluginKeyStatus('never-configured.js', 'arg'), 'pending');
});

// Force exit: the host's heartbeat interval / fetch-timeout timers would keep
// the event loop alive otherwise (same reason as hid-worker-host.test).
summaryExit();
