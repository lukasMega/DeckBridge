import assert from 'tjs:assert';
import { WorkerHidDriver } from '../src/hid-worker-host.js';
import { DEFAULT_MODEL } from '../src/devices/registry.js';
import type { DeviceModel } from '../src/devices/driver.js';

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

console.log('\nhid-worker-host: failed open cleanup');

const unknownModel: DeviceModel = { ...DEFAULT_MODEL, id: 'no-such-model' };

async function expectUnknownModelRejection(driver: WorkerHidDriver): Promise<void> {
  let err: Error | null = null;
  try {
    await driver.open();
  } catch (e) {
    err = e as Error;
  }
  assert.ok(err, 'open() should reject');
  assert.ok(/Unknown modelId/.test(err!.message), `unexpected error: ${err!.message}`);
}

await runTest('open() failure KEEPS the worker alive for reuse (no terminate)', async () => {
  const driver = new WorkerHidDriver(unknownModel);

  await expectUnknownModelRejection(driver);

  // Failed open must NOT terminate the worker: terminating a worker is SIGBUS-
  // prone on macOS, so it is kept idle for the next open() retry. close() (below)
  // is the single point that tears it down.
  const internal = driver as unknown as { worker: unknown; objectUrl: unknown };
  assert.ok(internal.worker != null, 'worker kept alive after failed open');
  assert.ok(internal.objectUrl != null, 'blob URL kept alive after failed open');

  await driver.close();
  assert.equal(internal.worker, null, 'close() tears down the worker');
  assert.equal(internal.objectUrl, null, 'close() revokes the blob URL');
});

await runTest('a second open() reuses the kept worker and rejects the same way', async () => {
  const driver = new WorkerHidDriver(unknownModel);

  await expectUnknownModelRejection(driver);
  const internal = driver as unknown as { worker: unknown; objectUrl: unknown };
  const firstWorker = internal.worker;

  await expectUnknownModelRejection(driver);
  assert.equal(internal.worker, firstWorker, 'second open() reused the same worker');

  await driver.close();
  assert.equal(internal.worker, null, 'close() tears down the reused worker');
});

console.log('\nhid-worker-host: setImageOverride');

await runTest('setImageOverride posts {type: setImageOverride, mode}', () => {
  const driver = new WorkerHidDriver(unknownModel);
  const posted: unknown[] = [];
  // Bypass the real worker — `post()` only needs `this.worker.postMessage`.
  (driver as unknown as { worker: { postMessage: (m: unknown) => void } }).worker = {
    postMessage: (m: unknown) => posted.push(m),
  };

  driver.setImageOverride('pad-edge');
  driver.setImageOverride(null);

  assert.deepEqual(posted, [
    { type: 'setImageOverride', mode: 'pad-edge' },
    { type: 'setImageOverride', mode: null },
  ]);
});

console.log(`\n${passed} passed, ${failed} failed`);
// Force exit: drivers that hit a failed open keep their worker alive (the fix),
// which would otherwise keep the event loop running and hang the test runner.
tjs.exit(failed > 0 ? 1 : 0);
