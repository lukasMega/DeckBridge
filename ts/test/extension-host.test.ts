import assert from 'tjs:assert';
import { ExtensionHost } from '../src/extension/extension-host.js';
import type { WorkerLike } from '../src/extension/extension-host.js';
import type { ExtensionEvent } from '../src/extension/api.js';
import type {
  ExtensionWorkerToMain,
  MainToExtensionWorker,
} from '../src/extension/extension-worker-protocol.js';
import { testAsync as runTest, summaryExit } from './helpers/harness.js';

const macrotask = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Worker stub: records what the host posts and lets the test answer. */
class FakeWorker implements WorkerLike {
  posted: MainToExtensionWorker[] = [];
  terminated = false;
  private msgCbs: Array<(ev: MessageEvent) => void> = [];
  private errCbs: Array<(ev: MessageEvent) => void> = [];

  postMessage(msg: MainToExtensionWorker): void {
    this.posted.push(msg);
  }
  terminate(): void {
    this.terminated = true;
  }
  addEventListener(type: 'message' | 'error', listener: (ev: MessageEvent) => void): void {
    (type === 'message' ? this.msgCbs : this.errCbs).push(listener);
  }
  emit(msg: ExtensionWorkerToMain): void {
    for (const cb of this.msgCbs) cb({ data: msg } as unknown as MessageEvent);
  }
  emitError(message: string): void {
    for (const cb of this.errCbs) cb({ message } as unknown as MessageEvent);
  }
  of<T extends MainToExtensionWorker['type']>(
    type: T,
  ): Extract<MainToExtensionWorker, { type: T }>[] {
    return this.posted.filter(
      (m): m is Extract<MainToExtensionWorker, { type: T }> => m.type === type,
    );
  }
}

interface Priv {
  hbTick(): void;
  flush(): void;
}
const priv = (h: ExtensionHost): Priv => h as unknown as Priv;

function makeHost(initial: ExtensionEvent[] = []): {
  host: ExtensionHost;
  workers: FakeWorker[];
  states: string[];
} {
  const workers: FakeWorker[] = [];
  const states: string[] = [];
  const host = new ExtensionHost({
    id: 'demo',
    serverPath: '/ext/demo/server.js',
    appStartedAt: 123,
    onState: () => states.push(host.state),
    initialEvents: () => initial,
    workerFactory: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
  });
  return { host, workers, states };
}

const input = (mk2: number): ExtensionEvent => ({
  type: 'input',
  at: mk2,
  deviceKey: 'k',
  input: { kind: 'key', mk2, state: 'down' },
});

console.log('\nExtensionHost');

await runTest('start posts load with the server path and app start', () => {
  const { host, workers } = makeHost();
  host.start();
  assert.deepEqual(workers[0]!.of('load'), [
    { type: 'load', id: 'demo', path: '/ext/demo/server.js', appStartedAt: 123 },
  ]);
  assert.equal(host.state, 'loading');
  host.stop();
});

await runTest('events queue while loading and go out in one batch once loaded', () => {
  const { host, workers, states } = makeHost();
  host.start();
  host.emit(input(1));
  host.emit(input(2));
  assert.equal(workers[0]!.of('events').length, 0);
  workers[0]!.emit({ type: 'loaded' });
  assert.deepEqual(states, ['running']);
  const batches = workers[0]!.of('events');
  assert.equal(batches.length, 1);
  assert.deepEqual(
    batches[0]!.events.map((e) => e.at),
    [1, 2],
  );
  host.stop();
});

await runTest('every started worker gets the initial events first, also after a crash', () => {
  const { host, workers } = makeHost([input(0)]);
  host.start();
  host.emit(input(1));
  workers[0]!.emit({ type: 'loaded' });
  assert.deepEqual(
    workers[0]!.of('events')[0]!.events.map((e) => e.at),
    [0, 1],
  );
  workers[0]!.emitError('crash');
  host.emit(input(2));
  workers[1]!.emit({ type: 'loaded' });
  assert.deepEqual(
    workers[1]!.of('events')[0]!.events.map((e) => e.at),
    [0, 2],
    'the restarted worker learns the decks again',
  );
  host.stop();
});

await runTest('a running host batches events on a timer', async () => {
  const { host, workers } = makeHost();
  host.start();
  workers[0]!.emit({ type: 'loaded' });
  host.emit(input(1));
  host.emit(input(2));
  assert.equal(workers[0]!.of('events').length, 0, 'not sent synchronously');
  await sleepMs(300);
  const batches = workers[0]!.of('events');
  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.events.length, 2);
  host.stop();
});

await runTest('the queue is capped while the worker loads', () => {
  const { host, workers } = makeHost();
  host.start();
  for (let i = 0; i < 5010; i++) host.emit(input(i));
  workers[0]!.emit({ type: 'loaded' });
  assert.equal(workers[0]!.of('events')[0]!.events.length, 5000);
  host.stop();
});

await runTest('a request is proxied and answered by its reqId', async () => {
  const { host, workers } = makeHost();
  host.start();
  workers[0]!.emit({ type: 'loaded' });
  const pending = host.request({ method: 'GET', path: 'snapshot', query: { a: '1' } });
  const sent = workers[0]!.of('request')[0]!;
  assert.equal(sent.path, 'snapshot');
  assert.deepEqual(sent.query, { a: '1' });
  workers[0]!.emit({ type: 'response', reqId: sent.reqId, status: 201, body: { ok: 1 } });
  assert.deepEqual(await pending, { status: 201, body: { ok: 1 } });
  host.stop();
});

await runTest('an out-of-range status from the worker becomes a 500', async () => {
  const { host, workers } = makeHost();
  host.start();
  workers[0]!.emit({ type: 'loaded' });
  const pending = host.request({ method: 'GET', path: 'x', query: {} });
  const { reqId } = workers[0]!.of('request')[0]!;
  workers[0]!.emit({ type: 'response', reqId, status: 99, body: null });
  assert.equal((await pending).status, 500);
  host.stop();
});

await runTest('requests answer 503 while loading and past the in-flight cap', async () => {
  const { host, workers } = makeHost();
  host.start();
  assert.equal((await host.request({ method: 'GET', path: 'x', query: {} })).status, 503);
  workers[0]!.emit({ type: 'loaded' });
  const held = Array.from({ length: 8 }, () =>
    host.request({ method: 'GET', path: 'x', query: {} }),
  );
  assert.equal((await host.request({ method: 'GET', path: 'x', query: {} })).status, 503);
  host.stop();
  const answers = await Promise.all(held);
  assert.ok(
    answers.every((a) => a.status === 503),
    'stop answers every pending request',
  );
});

await runTest('a load error is terminal', async () => {
  const { host, workers, states } = makeHost();
  host.start();
  workers[0]!.emit({ type: 'loadError', message: 'boom' });
  assert.equal(host.state, 'error');
  assert.equal(host.error, 'load failed: boom');
  assert.deepEqual(states, ['error']);
  host.emit(input(1));
  await macrotask();
  assert.ok(workers[0]!.terminated);
  assert.equal(workers.length, 1, 'no respawn');
});

await runTest('a wedged worker is replaced; the third death stops the extension', async () => {
  const { host, workers } = makeHost();
  host.start();
  workers[0]!.emit({ type: 'loaded' });
  priv(host).hbTick(); // ping
  priv(host).hbTick(); // missed 1
  priv(host).hbTick(); // missed 2 → dead
  assert.equal(workers.length, 2, 'respawned after a heartbeat timeout');
  assert.equal(host.state, 'loading');
  workers[1]!.emit({ type: 'loaded' });
  workers[1]!.emit({ type: 'pong', seq: 1 }); // a pong does not forgive the death
  workers[1]!.emitError('crash');
  assert.equal(workers.length, 3);
  workers[2]!.emitError('crash again');
  assert.equal(host.state, 'error');
  assert.ok(/stopped after 3 crashes/.test(host.error ?? ''), host.error);
  await macrotask();
  assert.ok(workers.every((w) => w.terminated));
});

await runTest('a replaced worker cannot answer for the new one', async () => {
  const { host, workers } = makeHost();
  host.start();
  workers[0]!.emit({ type: 'loaded' });
  const pending = host.request({ method: 'GET', path: 'x', query: {} });
  workers[0]!.emitError('crash');
  assert.equal((await pending).status, 503);
  workers[0]!.emit({ type: 'loaded' });
  assert.equal(host.state, 'loading', 'late message from the dead worker ignored');
  host.stop();
});

// The real worker entry, over a server.js on disk.

const DIR = `${tjs.tmpDir}/extension-host-test-${tjs.pid}`;
await tjs.makeDir(DIR, { recursive: true });

let serverSeq = 0;

async function realHost(source: string): Promise<{ host: ExtensionHost; states: string[] }> {
  const path = `${DIR}/server-${++serverSeq}.js`;
  await tjs.writeFile(path, source);
  const states: string[] = [];
  const host = new ExtensionHost({
    id: 'real',
    serverPath: path,
    appStartedAt: 42,
    onState: () => states.push(host.state),
  });
  host.start();
  return { host, states };
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await sleepMs(10);
  }
}

await runTest('real worker: loads server.js, takes events, answers requests', async () => {
  const { host } = await realHost(`
    export default (ctx) => {
      const seen = [];
      return {
        onEvents(events) { for (const e of events) seen.push(e.at); },
        handle(req) {
          if (req.path === 'fetch-gone') return { body: typeof fetch };
          return { body: { seen, app: ctx.appStartedAt, id: ctx.id, q: req.query, b: req.body } };
        },
      };
    };
  `);
  await until(() => host.state === 'running');
  host.emit(input(7));
  host.emit(input(8));
  await sleepMs(400);
  const r = await host.request({ method: 'POST', path: 'x', query: { q: '1' }, body: { n: 2 } });
  assert.deepEqual(r, {
    status: 200,
    body: { seen: [7, 8], app: 42, id: 'real', q: { q: '1' }, b: { n: 2 } },
  });
  const gone = await host.request({ method: 'GET', path: 'fetch-gone', query: {} });
  assert.equal(gone.body, 'undefined', 'global fetch is removed before import');
  host.stop();
});

await runTest('real worker: a throwing handler answers 500', async () => {
  const { host } = await realHost(
    `export default () => ({ handle() { throw new Error('nope'); } });`,
  );
  await until(() => host.state === 'running');
  assert.deepEqual(await host.request({ method: 'GET', path: 'x', query: {} }), {
    status: 500,
    body: { error: 'nope' },
  });
  host.stop();
});

await runTest('real worker: server.js without a default factory is a load error', async () => {
  const { host } = await realHost(`export const x = 1;`);
  await until(() => host.state === 'error');
  assert.ok(/must `export default/.test(host.error ?? ''), host.error);
});

await tjs.remove(DIR, { recursive: true }).catch(() => undefined);
summaryExit();
