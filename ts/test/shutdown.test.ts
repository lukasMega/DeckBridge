import assert from 'tjs:assert';
import { createShutdown, type ShutdownPlan } from '../src/main/shutdown.js';
import { PersistedSettings } from '../src/infra/settings.js';
import { loadSettings } from '../src/infra/settings-store.js';
import { testAsync as test, summary } from './helpers/harness.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const ROOT = `${tjs.tmpDir}/shutdown-test-${tjs.pid}`;

/** A plan recording every step; owners/persist overridable per test. */
function recorder(over: Partial<ShutdownPlan> = {}): { plan: ShutdownPlan; events: string[] } {
  const events: string[] = [];
  const plan: ShutdownPlan = {
    quiesce: () => events.push('quiesce'),
    owners: [
      ['docks', () => Promise.resolve(events.push('docks'))],
      ['webui', () => Promise.resolve(events.push('webui'))],
    ],
    persist: () => {
      events.push('persist');
      return Promise.resolve(true);
    },
    drainLogs: () => Promise.resolve(events.push('logs')),
    exit: (code) => events.push(`exit ${code}`),
    ...over,
  };
  return { plan, events };
}

console.log('\nshutdown orchestration');

await test('signals + tray Quit share one run and exit once', async () => {
  const { plan, events } = recorder();
  const shutdown = createShutdown(plan);
  const runs = [shutdown(), shutdown(), shutdown()];
  assert.ok(runs.every((r) => r === runs[0]));
  await Promise.all(runs);
  assert.deepEqual(
    events.filter((e) => e.startsWith('exit')),
    ['exit 0'],
  );
});

await test('order: quiesce, owners, persist, then logs, then exit', async () => {
  const { plan, events } = recorder();
  await createShutdown(plan)();
  assert.deepEqual(events, ['quiesce', 'docks', 'webui', 'persist', 'logs', 'exit 0']);
});

await test('exit waits for a slow final settings write', async () => {
  const { plan, events } = recorder({
    persist: async () => {
      await sleep(80);
      events.push('renamed');
      return true;
    },
  });
  await createShutdown(plan)();
  assert.deepEqual(events.slice(-3), ['renamed', 'logs', 'exit 0']);
});

await test('a failing owner does not stop the others; exit reports failure', async () => {
  const { plan, events } = recorder({
    owners: [
      ['commands', () => Promise.reject(new Error('boom'))],
      ['docks', () => Promise.resolve(events.push('docks'))],
    ],
  });
  await createShutdown(plan)();
  assert.ok(events.includes('docks'));
  assert.ok(events.includes('persist'), 'settings still written');
  assert.equal(events.at(-1), 'exit 1');
});

await test('a hung owner: budget expires, settings and logs still run, failure exit', async () => {
  const { plan, events } = recorder({
    owners: [['plugins', () => new Promise(() => {})]],
  });
  const t0 = Date.now();
  await createShutdown(plan, 120, 50)();
  assert.ok(Date.now() - t0 < 500, 'bounded by the budget');
  assert.deepEqual(events.slice(-3), ['persist', 'logs', 'exit 1']);
});

await test('a failed final write turns into a failure exit', async () => {
  const { plan, events } = recorder({ persist: () => Promise.resolve(false) });
  await createShutdown(plan)();
  assert.equal(events.at(-1), 'exit 1');
});

await test('a throwing quiesce still closes, persists and exits', async () => {
  const { plan, events } = recorder({
    quiesce: () => {
      throw new Error('bad timer');
    },
  });
  await createShutdown(plan)();
  assert.deepEqual(events, ['docks', 'webui', 'persist', 'logs', 'exit 1']);
});

await test('drain rejection: failure exit, exactly one exit call', async () => {
  const { plan, events } = recorder({ drainLogs: () => Promise.reject(new Error('disk')) });
  await createShutdown(plan)();
  assert.deepEqual(
    events.filter((e) => e.startsWith('exit')),
    ['exit 1'],
  );
});

await test('drain that never settles is bounded and fails the exit', async () => {
  const { plan, events } = recorder({ drainLogs: () => new Promise(() => {}) });
  const t0 = Date.now();
  await createShutdown(plan)();
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(events.at(-1), 'exit 1');
});

await test('a late drain rejection after the timeout stays observed', async () => {
  let reject: (e: Error) => void = () => {};
  const { plan, events } = recorder({
    drainLogs: () => new Promise((_, rej) => (reject = rej)),
  });
  await createShutdown(plan)();
  reject(new Error('late'));
  await sleep(20);
  assert.equal(events.at(-1), 'exit 1');
});

await test('owner failure still attempts settings and drain', async () => {
  const { plan, events } = recorder({
    owners: [['docks', () => Promise.reject(new Error('close ack missing'))]],
  });
  await createShutdown(plan)();
  assert.deepEqual(events, ['quiesce', 'persist', 'logs', 'exit 1']);
});

console.log('\nPersistedSettings.close()');

await test('close() lands the newest preference; reload sees it', async () => {
  const dir = `${ROOT}/newest`;
  const settings = new PersistedSettings(dir);
  for (let i = 0; i < 10; i++) {
    settings.selectedDock = i;
    settings.persist();
  }
  assert.equal(await settings.close(), true);
  assert.equal((await loadSettings(dir)).selectedDock, 9);
});

await test('after close() nothing more is written', async () => {
  const dir = `${ROOT}/frozen`;
  const settings = new PersistedSettings(dir);
  settings.selectedDock = 1;
  settings.persist();
  await settings.close();
  settings.selectedDock = 2;
  settings.persist(); // a late update check / daily ping
  await settings.flush();
  assert.equal((await loadSettings(dir)).selectedDock, 1);
});

await test('close() reports a failed final write', async () => {
  // A file where the cache directory should be: makeDir fails.
  await tjs.makeDir(ROOT, { recursive: true });
  const blocker = `${ROOT}/not-a-dir`;
  await tjs.writeFile(blocker, 'x');
  const settings = new PersistedSettings(blocker);
  settings.selectedDock = 4;
  settings.persist();
  assert.equal(await settings.close(), false);
});

await tjs.remove(ROOT, { recursive: true }).catch(() => undefined);

summary();
