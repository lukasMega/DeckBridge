import assert from 'tjs:assert';
import { PluginHost, listPluginFiles, pluginKeyStatus } from '../src/plugin-host.js';
import type { WorkerLike } from '../src/plugin-host.js';
import type { MainToPluginWorker, PluginWorkerToMain } from '../src/plugin-worker-protocol.js';

let passed = 0;
let failed = 0;

async function runTest(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

const macrotask = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

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
  // ── test drivers ──
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

// ── protocol shapes ───────────────────────────────────────────────────────────

console.log('\nplugin-worker-protocol');

await runTest('configure/value/fetch/pong message shapes round-trip', () => {
  const cfg: MainToPluginWorker = {
    type: 'configure',
    plugins: [{ key: 'a\0x', path: `${PLUGINS_DIR}/a.js`, param: 'x', intervalMs: 30_000 }],
  };
  assert.equal(cfg.type, 'configure');
  assert.equal(cfg.plugins[0]!.path, `${PLUGINS_DIR}/a.js`);

  const value: PluginWorkerToMain = { type: 'value', key: 'k', value: 'hi' };
  const cleared: PluginWorkerToMain = { type: 'value', key: 'k', value: null };
  assert.equal(value.value, 'hi');
  assert.equal(cleared.value, null);

  const fetchReq: PluginWorkerToMain = { type: 'fetch', fetchId: 7, url: HTTP_URL };
  const fetchRes: MainToPluginWorker = {
    type: 'fetchResult',
    fetchId: 7,
    ok: true,
    status: 200,
    body: '{}',
  };
  assert.equal(fetchReq.fetchId, fetchRes.fetchId);
});

// ── request / value cache ───────────────────────────────────────────────────────

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

// ── ctx.fetch proxy (runs on the host/main thread) ──────────────────────────────

console.log('\nPluginHost fetch proxy');

await runTest('plaintext fetch request → main-thread fetch → fetchResult', async () => {
  const realFetch = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = (url: string) =>
    Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(`body:${url}`) });
  try {
    const { host, workers } = makeHost();
    host.request('p.js', undefined, undefined, () => {});
    workers[0]!.emit({ type: 'fetch', fetchId: 1, url: HTTP_URL });
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
  workers[0]!.emit({ type: 'fetch', fetchId: 2, url: 'https://example/x' });
  await macrotask();
  const res = workers[0]!.posted.find((m) => m.type === 'fetchResult') as
    | { ok: boolean; error?: string }
    | undefined;
  assert.ok(res, 'fetchResult posted');
  assert.equal(res!.ok, false);
  assert.ok((res!.error ?? '').includes('TLS'), 'error explains the no-TLS limitation');
  host.stop();
});

// ── heartbeat watchdog ──────────────────────────────────────────────────────────

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

// ── reaping ──────────────────────────────────────────────────────────────────────

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

// ── listPluginFiles ────────────────────────────────────────────────────────────

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

console.log(`\n${passed} passed, ${failed} failed`);
// Force exit: the host's heartbeat interval / fetch-timeout timers would keep
// the event loop alive otherwise (same reason as hid-worker-host.test).
tjs.exit(failed > 0 ? 1 : 0);
