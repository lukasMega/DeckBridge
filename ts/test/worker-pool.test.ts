import assert from 'tjs:assert';
import { WorkerPool } from '../src/main/worker-pool.js';
import type { WorkerHidDriver } from '../src/worker/hid-worker-host.js';
import { MIRABOX_293_MODEL } from '../src/devices/mirabox/mirabox-293.js';
import { MIRABOX_293S_MODEL } from '../src/devices/mirabox/mirabox-293s.js';
import { test, testAsync, summaryExit } from './helpers/harness.js';

class FakeWorker {
  closed = false;
  levels: string[] = [];
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
  removeAllListeners(): void {}
  setLogLevel(level: string): void {
    this.levels.push(level);
  }
}

function pool(): { pool: WorkerPool; made: FakeWorker[] } {
  const made: FakeWorker[] = [];
  const p = new WorkerPool(() => {
    const w = new FakeWorker();
    made.push(w);
    return w as unknown as WorkerHidDriver;
  });
  return { pool: p, made };
}

console.log('\nWorkerPool');

test('a parked worker is handed out again, per model id', () => {
  const { pool: p, made } = pool();
  const first = p.acquire(MIRABOX_293_MODEL);
  assert.equal(first.fresh, true);
  p.park(MIRABOX_293_MODEL.id, first.driver);
  assert.equal(p.acquire(MIRABOX_293S_MODEL).fresh, true, 'other model spawns');
  const again = p.acquire(MIRABOX_293_MODEL);
  assert.equal(again.fresh, false);
  assert.equal(again.driver, first.driver);
  assert.equal(p.acquire(MIRABOX_293_MODEL).fresh, true, 'taken, not shared');
  assert.equal(made.length, 3);
});

await testAsync('closeAll terminates parked workers and empties the pool', async () => {
  const { pool: p, made } = pool();
  p.park(MIRABOX_293_MODEL.id, p.acquire(MIRABOX_293_MODEL).driver);
  p.setLogLevel('debug');
  await p.closeAll();
  assert.equal(made[0]!.closed, true);
  assert.deepEqual(made[0]!.levels, ['debug']);
  assert.equal(p.acquire(MIRABOX_293_MODEL).fresh, true);
});

await testAsync('closeAll closes every parked worker even when one fails', async () => {
  const { pool: p, made } = pool();
  p.park(MIRABOX_293_MODEL.id, p.acquire(MIRABOX_293_MODEL).driver);
  p.park(MIRABOX_293S_MODEL.id, p.acquire(MIRABOX_293S_MODEL).driver);
  made[0]!.close = () => Promise.reject(new Error('no ack'));
  let err: unknown;
  await p.closeAll().catch((e: unknown) => (err = e));
  assert.ok(err instanceof Error);
  assert.equal(made[1]!.closed, true);
});

summaryExit();
