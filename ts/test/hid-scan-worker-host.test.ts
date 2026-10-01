import assert from 'tjs:assert';
import { HidScanWorkerHost } from '../src/worker/hid-scan-worker-host.js';
import type { MainToHidScanWorker } from '../src/worker/hid-scan-worker-protocol.js';
import { testAsync as test, summaryExit } from './helpers/harness.js';

class FakeScanWorker {
  readonly posted: MainToHidScanWorker[] = [];
  private messageListener: ((ev: MessageEvent) => void) | null = null;
  private errorListener: ((ev: Event) => void) | null = null;
  terminated = 0;

  terminate(): void {
    this.terminated++;
  }

  postMessage(msg: MainToHidScanWorker): void {
    this.posted.push(msg);
  }

  addEventListener(type: 'message' | 'error', listener: (ev: MessageEvent | Event) => void): void {
    if (type === 'message') this.messageListener = listener;
    else this.errorListener = listener;
  }

  finish(tookMs: number): void {
    this.messageListener?.({
      data: { type: 'scanResult', devices: [], tookMs },
    } as MessageEvent);
  }

  finishInventory(tookMs: number, error?: string): void {
    this.messageListener?.({
      data: { type: 'inventoryResult', devices: [], tookMs, error },
    } as MessageEvent);
  }

  fail(message: string): void {
    this.errorListener?.({ message } as unknown as Event);
  }
}

console.log('\nhid-scan-worker-host: scan serialization');

await test('concurrent callers share one scan', async () => {
  const worker = new FakeScanWorker();
  const host = new HidScanWorkerHost(() => ({ worker }));
  const first = host.scan();
  const second = host.scan();
  assert.equal(first, second);
  assert.equal(worker.posted.length, 1);
  worker.finish(45_263);
  assert.equal((await first).tookMs, 45_263);
  assert.equal((await second).tookMs, 45_263);
});

await test('completed scan permits next scan', async () => {
  const worker = new FakeScanWorker();
  const host = new HidScanWorkerHost(() => ({ worker }));
  const first = host.scan();
  worker.finish(20);
  await first;
  const second = host.scan();
  assert.equal(worker.posted.length, 2);
  worker.finish(25);
  assert.equal((await second).tookMs, 25);
});

await test('worker failure rejects scan', async () => {
  const worker = new FakeScanWorker();
  const host = new HidScanWorkerHost(() => ({ worker }));
  const scan = host.scan();
  worker.fail('boom');
  let error: Error | null = null;
  try {
    await scan;
  } catch (e) {
    error = e as Error;
  }
  assert.ok(error);
  assert.ok(/boom/.test(error?.message ?? ''));
});

await test('requested reset rides the next scan, once', async () => {
  const worker = new FakeScanWorker();
  const host = new HidScanWorkerHost(() => ({ worker }));
  host.requestReset();
  const first = host.scan();
  assert.equal((worker.posted[0] as { reset?: boolean }).reset, true);
  worker.finish(10);
  await first;
  const second = host.scan();
  assert.equal((worker.posted[1] as { reset?: boolean }).reset, undefined);
  worker.finish(10);
  await second;
});

await test('reset survives a scan already in flight', async () => {
  const worker = new FakeScanWorker();
  const host = new HidScanWorkerHost(() => ({ worker }));
  const first = host.scan();
  host.requestReset(); // disconnect arrives mid-scan: that result is stale state
  worker.finish(10);
  await first;
  const second = host.scan();
  assert.equal((worker.posted[1] as { reset?: boolean }).reset, true);
  worker.finish(10);
  await second;
});

await test('dispose settles a waiting scan, ignores its late result, refuses new scans', async () => {
  const worker = new FakeScanWorker();
  const host = new HidScanWorkerHost(() => ({ worker }));
  const waiting = host.scan();
  host.dispose();
  let err = '';
  await waiting.catch((e: unknown) => (err = (e as Error).message));
  assert.equal(err, 'HID discovery disposed');
  worker.finish(10); // the blocked native scan finally returns: ignored
  let refused = false;
  await host.scan().catch(() => (refused = true));
  assert.ok(refused);
  assert.equal(worker.posted.length, 1, 'no scan posted after dispose');
});

console.log('\nhid-scan-worker-host: inventory');

await test('concurrent inventory callers share one request', async () => {
  const worker = new FakeScanWorker();
  const host = new HidScanWorkerHost(() => ({ worker }));
  const first = host.inventory();
  const second = host.inventory();
  assert.equal(first, second);
  assert.equal(worker.posted.length, 1);
  assert.equal(worker.posted[0]?.type, 'inventory');
  worker.finishInventory(7);
  assert.equal((await first).tookMs, 7);
});

await test('scan and inventory are independent slots', async () => {
  const worker = new FakeScanWorker();
  const host = new HidScanWorkerHost(() => ({ worker }));
  const scan = host.scan();
  const inv = host.inventory();
  assert.ok(scan !== inv);
  assert.equal(worker.posted.length, 2);
  worker.finishInventory(3);
  assert.equal((await inv).tookMs, 3);
  worker.finish(4);
  assert.equal((await scan).tookMs, 4);
  const again = host.inventory();
  assert.equal(worker.posted.length, 3, 'completed inventory permits the next');
  worker.finishInventory(1);
  await again;
});

await test('inventory error string rejects the caller', async () => {
  const worker = new FakeScanWorker();
  const host = new HidScanWorkerHost(() => ({ worker }));
  const inv = host.inventory();
  worker.finishInventory(0, 'enum blew up');
  let err = '';
  await inv.catch((e: unknown) => (err = (e as Error).message));
  assert.equal(err, 'enum blew up');
});

await test('dispose rejects waiting inventory and refuses new ones', async () => {
  const worker = new FakeScanWorker();
  const host = new HidScanWorkerHost(() => ({ worker }));
  const inv = host.inventory();
  host.dispose();
  let err = '';
  await inv.catch((e: unknown) => (err = (e as Error).message));
  assert.equal(err, 'HID discovery disposed');
  let refused = false;
  await host.inventory().catch(() => (refused = true));
  assert.ok(refused);
  assert.equal(worker.terminated, 0, 'dispose never terminates');
});

console.log('\nhid-scan-worker-host: worker ownership');

await test('error revokes the url, terminates the old worker, and respawns', async () => {
  const workers: FakeScanWorker[] = [];
  const hostUrls = ['blob:a', 'blob:b'];
  const host = new HidScanWorkerHost(() => {
    const worker = new FakeScanWorker();
    workers.push(worker);
    return { worker, url: hostUrls[workers.length - 1] };
  });
  const revoked: string[] = [];
  const orig = URL.revokeObjectURL.bind(URL);
  URL.revokeObjectURL = (u: string) => void revoked.push(u);
  try {
    const first = host.scan();
    workers[0]!.fail('dead');
    await first.catch(() => undefined);
    assert.deepEqual(revoked, ['blob:a']);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(workers[0]!.terminated, 1);
    const second = host.scan();
    assert.equal(workers.length, 2, 'fresh worker after the error');
    workers[0]!.finish(99); // late event from the retired worker: ignored
    workers[1]!.finish(5);
    assert.equal((await second).tookMs, 5);
    assert.deepEqual(revoked, ['blob:a'], 'live worker url is kept');
  } finally {
    URL.revokeObjectURL = orig;
  }
});

summaryExit();
