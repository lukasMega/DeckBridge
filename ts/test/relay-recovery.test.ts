import assert from 'tjs:assert';
import { createUpstreamWatcher } from '../src/main/relay/recovery.js';
import type { UpstreamWatcherDeps } from '../src/main/relay/recovery.js';
import type { DockIdentity } from '../src/main/relay/identity.js';
import { testAsync, summaryExit } from './helpers/harness.js';

const ID: DockIdentity = { serial: 'SN1', productId: 0x80, childPort: 5344 };

interface Rig {
  logs: string[];
  sleeps: number[];
  probes: number;
  recovered: [DockIdentity, DockIdentity][];
  lost: () => void;
  stop: () => void;
  settle: () => Promise<void>;
}

// results: one entry per probe call, an Error fails it; past the end the last one repeats.
function rig(results: (DockIdentity | Error)[], over: Partial<UpstreamWatcherDeps> = {}): Rig {
  const r: Rig = {
    logs: [],
    sleeps: [],
    probes: 0,
    recovered: [],
    lost: () => {},
    stop: () => {},
    settle: () => Promise.resolve(),
  };
  const { promise: stopP, resolve } = Promise.withResolvers<void>();
  let stopped = false;
  r.stop = (): void => {
    stopped = true;
    resolve();
  };
  r.lost = createUpstreamWatcher(ID, {
    probe: () => {
      const res = results[Math.min(r.probes++, results.length - 1)]!;
      return res instanceof Error ? Promise.reject(res) : Promise.resolve(res);
    },
    sleep: (ms) => {
      r.sleeps.push(ms);
      return Promise.resolve();
    },
    stop: stopP,
    isStopped: () => stopped,
    log: (level, m) => r.logs.push(`${level}: ${m}`),
    onRecovered: (prev, next) => {
      r.recovered.push([prev, next]);
    },
    ...over,
  }) as () => void;
  // Let the microtask chain of a recovery drain.
  r.settle = async (): Promise<void> => {
    for (let i = 0; i < 50; i++) await Promise.resolve();
  };
  return r;
}

console.log('relay recovery');

await testAsync('first probe ok: no warn, no recovery callback', async () => {
  const r = rig([ID]);
  r.lost();
  await r.settle();
  assert.equal(r.probes, 1);
  assert.deepEqual(r.logs, []);
  assert.deepEqual(r.sleeps, []);
  assert.equal(r.recovered.length, 0);
});

await testAsync('fail twice then ok: one warn, one info, backoff 1000 2000', async () => {
  const r = rig([new Error('refused'), new Error('refused'), ID]);
  r.lost();
  await r.settle();
  assert.equal(r.probes, 3);
  assert.deepEqual(r.sleeps, [1000, 2000]);
  assert.equal(r.logs.filter((l) => l.startsWith('warn:')).length, 1);
  assert.ok(r.logs[0]!.includes('DeckBridge unreachable, retrying'));
  assert.equal(r.logs.filter((l) => l.startsWith('info:')).length, 1);
  assert.ok(r.logs.at(-1)!.startsWith('info: DeckBridge back after '));
});

await testAsync('backoff caps at 5000', async () => {
  const e = new Error('x');
  const r = rig([e, e, e, e, e, e, ID]);
  r.lost();
  await r.settle();
  assert.deepEqual(r.sleeps, [1000, 2000, 5000, 5000, 5000, 5000]);
});

await testAsync('concurrent lost events start one recovery', async () => {
  const r = rig([new Error('x'), ID]);
  r.lost();
  r.lost();
  r.lost();
  await r.settle();
  assert.equal(r.probes, 2);
  assert.deepEqual(r.sleeps, [1000]);
});

await testAsync('a later loss starts a new recovery', async () => {
  const r = rig([ID]);
  r.lost();
  await r.settle();
  r.lost();
  await r.settle();
  assert.equal(r.probes, 2);
});

await testAsync('identity change: onRecovered gets prev and next, warn logged', async () => {
  const next: DockIdentity = { serial: 'SN2', productId: 0x84, childPort: 5350 };
  const r = rig([next, next]);
  r.lost();
  await r.settle();
  assert.equal(r.recovered.length, 1);
  assert.deepEqual(r.recovered[0], [ID, next]);
  assert.ok(r.logs.some((l) => l.startsWith('warn: DeckBridge identity changed')));
  // next becomes the baseline: the same identity again is not a change
  r.lost();
  await r.settle();
  assert.equal(r.recovered.length, 1);
});

await testAsync('onRecovered throwing is logged, never escapes', async () => {
  const next: DockIdentity = { ...ID, childPort: 5350 };
  const r = rig([next], {
    onRecovered: () => {
      throw new Error('bind failed');
    },
  });
  r.lost();
  await r.settle();
  assert.ok(r.logs.some((l) => l.startsWith('error:') && l.includes('bind failed')));
});

await testAsync('stop during retries ends without more probes', async () => {
  const e = new Error('x');
  const r = rig([e, e, e, e, ID], {
    sleep: (ms) => {
      r.sleeps.push(ms);
      r.stop();
      return Promise.resolve();
    },
  });
  r.lost();
  await r.settle();
  assert.equal(r.probes, 1);
  assert.equal(r.recovered.length, 0);
  assert.ok(!r.logs.some((l) => l.includes('back after')));
  // and a lost event after stop is ignored
  r.lost();
  await r.settle();
  assert.equal(r.probes, 1);
});

summaryExit();
