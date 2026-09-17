import assert from 'tjs:assert';
import { HidScanWorkerHost } from '../src/hid-scan-worker-host.js';
import type { MainToHidScanWorker } from '../src/hid-scan-worker-protocol.js';
import { testAsync as test, summaryExit } from './helpers/harness.js';

class FakeScanWorker {
  readonly posted: MainToHidScanWorker[] = [];
  private messageListener: ((ev: MessageEvent) => void) | null = null;
  private errorListener: ((ev: Event) => void) | null = null;

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

  fail(message: string): void {
    this.errorListener?.({ message } as unknown as Event);
  }
}

console.log('\nhid-scan-worker-host: scan serialization');

await test('concurrent callers share one scan', async () => {
  const worker = new FakeScanWorker();
  const host = new HidScanWorkerHost(() => worker);
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
  const host = new HidScanWorkerHost(() => worker);
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
  const host = new HidScanWorkerHost(() => worker);
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
  const host = new HidScanWorkerHost(() => worker);
  host.requestReset();
  const first = host.scan();
  assert.equal(worker.posted[0]?.reset, true);
  worker.finish(10);
  await first;
  const second = host.scan();
  assert.equal(worker.posted[1]?.reset, undefined);
  worker.finish(10);
  await second;
});

await test('reset survives a scan already in flight', async () => {
  const worker = new FakeScanWorker();
  const host = new HidScanWorkerHost(() => worker);
  const first = host.scan();
  host.requestReset(); // disconnect arrives mid-scan: that result is stale state
  worker.finish(10);
  await first;
  const second = host.scan();
  assert.equal(worker.posted[1]?.reset, true);
  worker.finish(10);
  await second;
});

summaryExit();
