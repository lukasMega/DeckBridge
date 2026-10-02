import assert from 'tjs:assert';
import { WorkerHidDriver } from '../src/worker/hid-worker-host.js';
import { DEFAULT_MODEL } from '../src/devices/registry.js';
import type { DeviceModel } from '../src/devices/driver.js';
import type { WorkerToMain } from '../src/worker/hid-worker-protocol.js';
import { testAsync as runTest, summaryExit } from './helpers/harness.js';

console.log('\nhid-worker-host: failed open cleanup');

/** Work-queue ids are bookkeeping; these tests compare message payloads. */
function withoutId(m: unknown): unknown {
  const copy = { ...(m as { id?: number }) };
  delete copy.id;
  return copy;
}

const unknownModel: DeviceModel = { ...DEFAULT_MODEL, id: 'no-such-model' };

async function expectUnknownModelRejection(driver: WorkerHidDriver): Promise<void> {
  let err: Error | null = null;
  try {
    await driver.open('fake');
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

console.log('\nhid-worker-host: applyOverrides');

await runTest('applyOverrides posts the overrides and swaps the effective model', () => {
  const overrides = { image: { rotate: 90 as const } };
  const effective = { ...unknownModel, image: { ...unknownModel.image, rotate: 90 as const } };
  const driver = new WorkerHidDriver(unknownModel);
  const posted: unknown[] = [];
  (driver as unknown as { worker: { postMessage: (m: unknown) => void } }).worker = {
    postMessage: (m: unknown) => posted.push(withoutId(m)),
  };

  driver.applyOverrides(overrides, effective);

  assert.deepEqual(posted, [{ type: 'setOverrides', overrides }]);
  assert.equal(driver.model.image.rotate, 90, 'callers read the tuned spec off driver.model');

  // A later reopen must carry the NEW override, not the constructor's.
  posted.length = 0;
  void driver.open('fake');
  assert.deepEqual(posted, [
    { type: 'open', modelId: unknownModel.id, hidPath: 'fake', overrides },
  ]);
});

console.log('\nhid-worker-host: setTouchStripMask');

await runTest('setTouchStripMask / restoreTouchSegments post a copy of the wire ids', () => {
  const driver = new WorkerHidDriver(unknownModel);
  const posted: Array<{ type: string; wireIds?: number[] }> = [];
  (driver as unknown as { worker: { postMessage: (m: unknown) => void } }).worker = {
    postMessage: (m: unknown) => posted.push(withoutId(m) as { type: string; wireIds?: number[] }),
  };

  const ids = [1, 3];
  driver.setTouchStripMask(ids);
  driver.setTouchStripMask([]);
  driver.restoreTouchSegments(ids);
  ids.push(4);

  assert.deepEqual(posted, [
    { type: 'setTouchStripMask', wireIds: [1, 3] },
    { type: 'setTouchStripMask', wireIds: [] },
    { type: 'restoreTouchSegments', wireIds: [1, 3] },
  ]);
  assert.notEqual(posted[0]!.wireIds, ids, 'caller array not aliased');
});

await runTest('setTouchStripOptions posts a copy of the options', () => {
  const driver = new WorkerHidDriver(unknownModel);
  const posted: unknown[] = [];
  (driver as unknown as { worker: { postMessage: (m: unknown) => void } }).worker = {
    postMessage: (m: unknown) => posted.push(withoutId(m)),
  };
  const options = { zoneFit: 'scale', upload: 'always' } as const;
  driver.setTouchStripOptions(options);
  assert.deepEqual(posted, [{ type: 'setTouchStripOptions', options }]);
  assert.ok((posted[0] as { options: unknown }).options !== options, 'not aliased');
});

await runTest('setSleep posts {type:setSleep} (sent as a control message)', () => {
  const driver = new WorkerHidDriver(unknownModel);
  const posted: unknown[] = [];
  (driver as unknown as { worker: { postMessage: (m: unknown) => void } }).worker = {
    postMessage: (m: unknown) => posted.push(withoutId(m)),
  };
  driver.setSleep(true);
  driver.setSleep(false);
  assert.deepEqual(posted, [
    { type: 'setSleep', asleep: true },
    { type: 'setSleep', asleep: false },
  ]);
});

console.log('\nhid-worker-host: bounded admission and close');

interface FakeWorker {
  posted: Array<{ type: string; id?: number; keyIndex?: number; region?: unknown }>;
  terminated: boolean;
  postMessage(m: unknown): void;
  terminate(): void;
}

interface HostInternals {
  worker: FakeWorker | null;
  onWorkerMessage(w: FakeWorker, msg: WorkerToMain): void;
}

/** A driver wired to a fake worker, as open() would leave it. */
function attached(): { driver: WorkerHidDriver; w: FakeWorker; send: (m: WorkerToMain) => void } {
  const driver = new WorkerHidDriver(unknownModel);
  const w: FakeWorker = {
    posted: [],
    terminated: false,
    postMessage(m) {
      this.posted.push(m as FakeWorker['posted'][number]);
    },
    terminate() {
      this.terminated = true;
    },
  };
  const internals = driver as unknown as HostInternals;
  internals.worker = w;
  return { driver, w, send: (m) => internals.onWorkerMessage(w, m) };
}

const jpeg = (n: number): Uint8Array => new Uint8Array(1024).fill(n);

await runTest('a stalled worker never has more than the posted budget outstanding', () => {
  const { driver, w, send } = attached();
  for (let i = 0; i < 1000; i++) driver.renderCoraImage(i % 8, jpeg(i), 'jpeg');
  assert.equal(w.posted.length, 15, 'only the posted budget reached the worker');
  assert.equal(driver.workQueue.pendingCount, 8, 'one waiting frame per key');
  send({ type: 'workDone', ids: w.posted.map((m) => m.id!) });
  assert.equal(w.posted.length, 23, 'acknowledgement drains the waiting frames');
  assert.equal(driver.workQueue.pendingCount, 0);
});

await runTest(
  'overload: one event, images refused until a fresh session, patches need a base',
  () => {
    const { driver, w } = attached();
    let overloads = 0;
    driver.on('overload', () => overloads++);
    const patch = { x: 0, y: 0, w: 10, h: 10 };
    for (let i = 0; i < 200; i++) driver.renderTouchImage(new Uint8Array(100), patch);
    assert.equal(overloads, 1, 'one event, not one per refused frame');
    const before = w.posted.length + driver.workQueue.pendingCount;
    driver.renderCoraImage(0, jpeg(1), 'jpeg');
    driver.renderTouchImage(new Uint8Array(100), patch);
    assert.equal(w.posted.length + driver.workQueue.pendingCount, before, 'suspended');
    driver.setBrightness(50); // controls are not suspended
    assert.equal(driver.workQueue.pendingCount, before - w.posted.length + 1);

    driver.workQueue.reset(); // as if the backlog drained
    driver.resumeImages();
    const posted = w.posted.length;
    driver.renderTouchImage(new Uint8Array(100), patch);
    assert.equal(w.posted.length, posted, 'patch before a full frame skipped');
    driver.renderTouchImage(new Uint8Array(100));
    driver.renderTouchImage(new Uint8Array(100), patch);
    assert.deepEqual(
      w.posted.slice(-2).map((m) => (m.region ? 'patch' : 'full')),
      ['full', 'patch'],
    );
  },
);

await runTest('concurrent close() calls share one completion', async () => {
  const { driver, w, send } = attached();
  const a = driver.close();
  const b = driver.close();
  assert.equal(a, b);
  assert.equal(w.posted.filter((m) => m.type === 'close').length, 1);
  send({ type: 'closed' });
  await Promise.all([a, b]);
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(w.terminated, 'terminated once the worker reported closed');
});

await runTest('close drops unposted frames and refuses new work', async () => {
  const { driver, w, send } = attached();
  for (let i = 0; i < 40; i++) driver.renderCoraImage(i, jpeg(i), 'jpeg');
  const p = driver.close();
  assert.equal(driver.workQueue.pendingCount, 0);
  const n = w.posted.length;
  driver.renderCoraImage(1, jpeg(1), 'jpeg');
  driver.setBrightness(10);
  assert.equal(w.posted.length, n, 'nothing admitted while closing');
  send({ type: 'closed' });
  await p;
});

await runTest('close rejects a pending open', async () => {
  const { driver, send } = attached();
  const opening = driver.open('fake').then(
    () => 'resolved',
    (e: unknown) => (e as Error).message,
  );
  const closing = driver.close();
  send({ type: 'closed' });
  await closing;
  assert.equal(await opening, 'driver closed');
});

await runTest(
  'close timeout: rejects, never terminates mid call, terminates on late closed',
  async () => {
    const { driver, w, send } = attached();
    const internals = driver as unknown as HostInternals;
    let err = '';
    await driver.close().catch((e: unknown) => (err = (e as Error).message));
    assert.equal(err, 'worker close timed out');
    assert.equal(internals.worker, null, 'detached so a reopen gets a fresh worker');
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(!w.terminated, 'not terminated while it may be inside a native call');
    send({ type: 'closed' }); // the native close finally finished
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(w.terminated);
  },
);

await runTest('an old close timer cannot touch the replacement worker', async () => {
  const { driver, w: oldWorker, send } = attached();
  const internals = driver as unknown as HostInternals;
  const closing = driver.close();
  send({ type: 'closed' });
  await closing;
  const next: FakeWorker = { ...oldWorker, posted: [], terminated: false };
  internals.worker = next;
  await new Promise((r) => setTimeout(r, 1100)); // past the old close grace
  assert.equal(internals.worker, next);
  assert.ok(!next.terminated);
  internals.worker = null;
});

console.log('\nhid-worker-host: local recovery after overload');

const spec = DEFAULT_MODEL.image;
const bmp = (n: number): Uint8Array => new Uint8Array(1024).fill(n);
const ids = (w: FakeWorker): number[] => w.posted.map((m) => m.id!);

/** Fill the posted + pending budget with CORA touch frames, so the next local image is refused. */
function overloadViaCora(driver: WorkerHidDriver): void {
  for (let i = 0; i < 200; i++) driver.renderTouchImage(new Uint8Array(100));
}

await runTest('local-only overload pauses local images with one warning, no CORA drop', () => {
  const { driver, w, send } = attached();
  let overloads = 0;
  let drained = 0;
  driver.on('overload', () => overloads++);
  driver.on('imagesDrained', () => drained++);
  // Fill the queue with local images of distinct keys (no coalescing).
  for (let i = 0; i < 200; i++) driver.sendSplashImage(i, bmp(i), spec);
  assert.equal(overloads, 0, 'local overload does not drop the CORA session');
  const held = w.posted.length + driver.workQueue.pendingCount;
  driver.sendSplashImage(999, bmp(1), spec);
  assert.equal(w.posted.length + driver.workQueue.pendingCount, held, 'paused');
  assert.equal(drained, 0);
  // Partial credits: not empty yet.
  send({ type: 'workDone', ids: ids(w).slice(0, 3) });
  assert.equal(drained, 0, 'no resume before the queue is completely empty');
  for (let n = 0; n < 50; n++) send({ type: 'workDone', ids: ids(w) });
  assert.equal(drained, 1, 'one transition');
  const before = w.posted.length;
  driver.sendSplashImage(5, bmp(5), spec);
  assert.equal(w.posted.length, before + 1, 'local image posts with no CORA session');
  send({ type: 'workDone', ids: ids(w) }); // duplicate/stale credits
  assert.equal(drained, 1, 'duplicate credits do not restart producers');
});

await runTest('CORA stays blocked until resumeImages while local recovers', () => {
  const { driver, w, send } = attached();
  let drained = 0;
  driver.on('imagesDrained', () => drained++);
  overloadViaCora(driver);
  for (let n = 0; n < 50; n++) send({ type: 'workDone', ids: ids(w) });
  assert.equal(drained, 1);
  const before = w.posted.length;
  driver.renderCoraImage(0, jpeg(1), 'jpeg');
  assert.equal(w.posted.length, before, 'stale CORA image still refused');
  driver.sendSplashImage(0, bmp(1), spec);
  assert.equal(w.posted.length, before + 1, 'local image accepted');
  driver.resumeImages();
  driver.renderCoraImage(1, jpeg(1), 'jpeg');
  assert.equal(w.posted.length, before + 2, 'CORA accepted after a fresh session');
});

await runTest('repeated overload cycles emit one drained transition each', () => {
  const { driver, w, send } = attached();
  let overloads = 0;
  let drained = 0;
  driver.on('overload', () => overloads++);
  driver.on('imagesDrained', () => drained++);
  for (let cycle = 1; cycle <= 3; cycle++) {
    overloadViaCora(driver);
    for (let n = 0; n < 50; n++) send({ type: 'workDone', ids: ids(w) });
    send({ type: 'workDone', ids: ids(w) });
    driver.resumeImages();
    assert.equal(overloads, cycle);
    assert.equal(drained, cycle);
  }
});

await runTest('an oversized image never suspends or loops', () => {
  const { driver, w } = attached();
  let overloads = 0;
  driver.on('overload', () => overloads++);
  driver.sendSplashImage(0, new Uint8Array(3 * 1024 * 1024), spec);
  driver.renderCoraImage(0, new Uint8Array(3 * 1024 * 1024), 'jpeg');
  assert.equal(overloads, 0);
  assert.equal(w.posted.length, 0);
  driver.sendSplashImage(1, bmp(1), spec);
  assert.equal(w.posted.length, 1, 'later images still flow');
});

await runTest('close or disconnect during a drain never emits imagesDrained', async () => {
  const a = attached();
  let drained = 0;
  a.driver.on('imagesDrained', () => drained++);
  overloadViaCora(a.driver);
  const closing = a.driver.close();
  a.send({ type: 'workDone', ids: ids(a.w) });
  a.send({ type: 'closed' });
  await closing;
  assert.equal(drained, 0);

  const b = attached();
  b.driver.on('imagesDrained', () => drained++);
  overloadViaCora(b.driver);
  const stale = ids(b.w);
  b.send({ type: 'disconnect' });
  b.send({ type: 'workDone', ids: stale });
  assert.equal(drained, 0, 'stale credits of an old generation are ignored');
});

await runTest('strip patch waits for a full base after resume', () => {
  const { driver, w, send } = attached();
  const patch = { x: 0, y: 0, w: 10, h: 10 };
  overloadViaCora(driver);
  for (let n = 0; n < 50; n++) send({ type: 'workDone', ids: ids(w) });
  driver.resumeImages();
  const before = w.posted.length;
  driver.renderTouchImage(new Uint8Array(100), patch);
  assert.equal(w.posted.length, before, 'patch skipped without a base');
  driver.renderTouchImage(new Uint8Array(100));
  assert.equal(w.posted.length, before + 1);
});

await runTest('splash and touch posts do not pre-copy; queued ones are snapshots', () => {
  const { driver, w } = attached();
  const src = bmp(7);
  driver.sendSplashImage(0, src, spec);
  const posted = w.posted[0] as unknown as { bytes: Uint8Array };
  assert.equal(posted.bytes, src, 'posted directly (postMessage clones synchronously)');
  // Fill the posted budget, then queue one and mutate its source.
  for (let i = 1; i < 15; i++) driver.sendSplashImage(i, bmp(i), spec);
  const queuedSrc = bmp(9);
  driver.sendSplashImage(50, queuedSrc, spec);
  assert.equal(driver.workQueue.pendingCount, 1);
  queuedSrc.fill(0);
  const t = w.posted.length;
  const q = driver.workQueue as unknown as { waiting: Array<{ msg: { bytes: Uint8Array } }> };
  assert.equal(q.waiting[0]!.msg.bytes[0], 9, 'waiting message is isolated from the caller');
  assert.equal(w.posted.length, t);
});

// Force exit: drivers that hit a failed open keep their worker alive (the fix),
// which would otherwise keep the event loop running and hang the test runner.
summaryExit();
