import assert from 'tjs:assert';
import { MiraboxDriver } from '../src/devices/mirabox/driver.js';
import { DEVICE_MODELS } from '../src/devices/registry.js';
import type { WorkMessage, WorkerToMain } from '../src/worker/hid-worker-protocol.js';
const MIRABOX_293S = DEVICE_MODELS.find((model) => model.id === 'mirabox-293s')!;
let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}
function summaryExit(): void {
  console.log(`\n${passed} passed, ${failed} failed`);
  tjs.exit(failed > 0 ? 1 : 0);
}

const writes: Buffer[] = [];
const messages: WorkerToMain[] = [];
const notificationTags: string[] = [];
let receive: ((ev: MessageEvent) => void) | undefined;
const scope = globalThis as unknown as {
  postMessage: (msg: WorkerToMain) => void;
  addEventListener: (type: string, callback: (ev: MessageEvent) => void) => void;
};
scope.postMessage = (msg) => {
  messages.push(msg);
  if (msg.type === 'imageSent') notificationTags.push(tag(writes.at(-1)!));
};
scope.addEventListener = (_type, callback) => {
  receive = callback;
};

// Exercise actual worker scheduling and report framing without claiming USB.
MiraboxDriver.prototype.open = function (): Promise<void> {
  const size = (this as unknown as { model: { wire: { packetSize: number } } }).model.wire
    .packetSize;
  Object.assign(this, {
    pktSize: size,
    device: {},
    hidLib: {
      close: () => undefined,
      symbols: {
        hid_write: (_dev: unknown, bytes: Uint8Array) => {
          writes.push(Buffer.from(bytes));
          return bytes.length;
        },
        hid_close: () => undefined,
        hid_exit: () => 0,
      },
    },
    _chunkScratch: Buffer.alloc(size),
    _writeScratch: Buffer.alloc(size + 1),
  });
  return Promise.resolve();
};
await import('../src/worker/hid-worker.js');

function send(msg: WorkMessage): void {
  receive!({ data: msg } as MessageEvent);
}
// Only for negative checks and fixed-window timing, where no observable signal exists;
// anything with a completion signal uses waitFor so a slow runner cannot flake it.
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
// The worker's collection window is 16 ms; generous enough for a slow runner, but a
// window stretched into visible latency still fails.
const MAX_FLUSH_MS = 100;
async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${predicate.toString()}`);
    await wait(1);
  }
}
const tag = (packet: Buffer): string => packet.subarray(6, 9).toString();
const stpCount = (): number => writes.filter((packet) => tag(packet) === 'STP').length;
// open() tunes transform to 'passthrough', so these bytes reach the driver verbatim.
const sendImage = (keyIndex: number, bytes: Uint8Array): void =>
  send({ type: 'image', keyIndex, bytes, format: 'jpeg' });

async function open(modelId: string, batchImageTransfers?: boolean): Promise<void> {
  messages.length = 0;
  send({
    type: 'open',
    modelId,
    hidPath: 'fake',
    overrides: {
      image: { transform: 'passthrough' },
      ...(batchImageTransfers === undefined ? {} : { wire: { batchImageTransfers } }),
    },
  });
  await waitFor(() => messages.some((m) => m.type === 'opened'));
  writes.length = 0;
  messages.length = 0;
  notificationTags.length = 0;
}

await test('293S page sends 15 BAT packets and one final STP', async () => {
  await open('mirabox-293s');
  for (let keyIndex = 0; keyIndex < 15; keyIndex++) {
    sendImage(keyIndex, new Uint8Array(600));
  }
  await waitFor(() => stpCount() >= 1);
  assert.equal(writes.filter((packet) => tag(packet) === 'BAT').length, 15);
  assert.equal(stpCount(), 1);
  assert.equal(tag(writes.at(-1)!), 'STP');
});

await test('isolated image flushes after fixed collection window', async () => {
  await open('mirabox-293s');
  const sentAt = Date.now();
  sendImage(13, new Uint8Array(20));
  await wait(5); // negative check: nothing to observe before the window closes
  assert.equal(writes.length, 0);
  await waitFor(() => stpCount() >= 1);
  const elapsed = Date.now() - sentAt;
  assert.ok(elapsed < MAX_FLUSH_MS, `flushed after ${elapsed} ms`);
  assert.equal(stpCount(), 1);
});

await test('293S batching override disables collection and per-batch STP', async () => {
  await open('mirabox-293s', false);
  for (let i = 0; i < 3; i++) sendImage(13, new Uint8Array(20));
  await waitFor(() => stpCount() >= 3);
  assert.equal(stpCount(), 3);
});

await test('293S rebadge batching can be enabled through tuning', async () => {
  await open('ajazz-akp153', true);
  const sentAt = Date.now();
  for (let i = 0; i < 3; i++) sendImage(13, new Uint8Array(20));
  await wait(5); // negative check: nothing to observe before the window closes
  assert.equal(writes.length, 0);
  await waitFor(() => stpCount() >= 1);
  const elapsed = Date.now() - sentAt;
  assert.ok(elapsed < MAX_FLUSH_MS, `flushed after ${elapsed} ms`);
  assert.equal(stpCount(), 1);
});

await test('unsupported board ignores injected batching override', async () => {
  await open('mirabox-293', true);
  for (let i = 0; i < 3; i++) sendImage(1, new Uint8Array(20));
  await waitFor(() => stpCount() >= 3);
  assert.equal(stpCount(), 3);
});

await test('CORA image completion notifications follow final STP', async () => {
  await open('mirabox-293s');
  for (let keyIndex = 0; keyIndex < 15; keyIndex++) {
    send({ type: 'image', keyIndex, bytes: new Uint8Array(20), format: 'jpeg' });
  }
  await waitFor(() => notificationTags.length >= 15);
  assert.equal(stpCount(), 1);
  assert.equal(notificationTags.length, 15);
  assert.ok(notificationTags.every((value) => value === 'STP'));
  // The hash rides on imageSent: no second message per frame.
  assert.ok(messages.every((m) => (m.type as string) !== 'frameHash'));
  const hashed = messages.flatMap((m) =>
    m.type === 'imageSent' && m.hash !== undefined ? [m.keyIndex] : [],
  );
  assert.deepEqual(
    hashed.toSorted((a, b) => a - b),
    Array.from({ length: 15 }, (_, i) => i),
  );
});

await test('workDone returns every batched id once, after imageSent and the final STP', async () => {
  await open('mirabox-293s');
  for (let keyIndex = 0; keyIndex < 3; keyIndex++) {
    send({
      type: 'image',
      keyIndex,
      bytes: new Uint8Array(20),
      format: 'jpeg',
      id: 100 + keyIndex,
    });
  }
  send({ type: 'setBrightness', level: 40, id: 200 });
  await waitFor(() => messages.some((m) => m.type === 'workDone' && m.ids.includes(200)));
  const done = messages.flatMap((m, i) => (m.type === 'workDone' ? [{ i, ids: m.ids }] : []));
  assert.deepEqual(
    done.map((d) => d.ids),
    [[100, 101, 102], [200]],
  );
  const lastSent = messages.findLastIndex((m) => m.type === 'imageSent');
  assert.ok(done[0]!.i > lastSent, 'credits follow the imageSent notifications');
});

await test('a failed message still returns its credit', async () => {
  await open('mirabox-293s');
  send({
    type: 'imageWithSpec',
    keyIndex: 1,
    bytes: new Uint8Array([0]),
    spec: MIRABOX_293S.image,
    id: 7,
  });
  send({ type: 'setBrightness', level: 33, id: 8 });
  await waitFor(() => messages.some((m) => m.type === 'workDone' && m.ids.includes(8)));
  const ids = messages.flatMap((m) => (m.type === 'workDone' ? m.ids : []));
  assert.deepEqual(
    ids.toSorted((a, b) => a - b),
    [7, 8],
  );
});

await test('page overflow receives another final STP', async () => {
  await open('mirabox-293s');
  for (let i = 0; i < 16; i++) {
    sendImage(13, new Uint8Array(20));
  }
  await waitFor(() => stpCount() >= 2);
  assert.equal(stpCount(), 2);
});

await test('continuous arrivals cannot reset flush deadline', async () => {
  await open('mirabox-293s');
  for (let i = 0; i < 5; i++) {
    sendImage(13, new Uint8Array(20));
    await wait(7);
  }
  assert.ok(stpCount() >= 1);
  await wait(25); // drain the pending flush timer so it cannot leak into the next test
});

await test('clear and brightness follow committed images', async () => {
  await open('mirabox-293s');
  sendImage(13, new Uint8Array(20));
  send({ type: 'clearKey', keyIndex: 13 });
  send({ type: 'setBrightness', level: 33 });
  await waitFor(() => writes.some((packet) => tag(packet) === 'LIG'));
  assert.deepEqual(writes.map(tag), ['BAT', '\u0000\u0000\u0000', 'STP', 'CLE', 'LIG']);
});

await test('close commits images before disconnect sequence', async () => {
  await open('mirabox-293s');
  sendImage(13, new Uint8Array(20));
  send({ type: 'close' });
  await waitFor(() => messages.some((m) => m.type === 'closed'));
  assert.equal(tag(writes[2]!), 'STP');
  assert.equal(tag(writes[3]!), 'CLE');
  assert.equal(tag(writes[4]!), 'HAN');
  assert.ok(messages.some((msg) => msg.type === 'closed'));
});

await test('transform failure still commits earlier images and releases queue', async () => {
  await open('mirabox-293s');
  sendImage(13, new Uint8Array(20));
  send({
    type: 'imageWithSpec',
    keyIndex: 1,
    bytes: new Uint8Array([0]),
    spec: MIRABOX_293S.image,
  });
  send({ type: 'setBrightness', level: 33 });
  await waitFor(() => writes.some((packet) => tag(packet) === 'LIG'));
  assert.equal(stpCount(), 1);
  assert.equal(tag(writes.at(-1)!), 'LIG');
  assert.ok(messages.some((msg) => msg.type === 'error'));
});

for (const { id: modelId } of DEVICE_MODELS.filter(
  (model) => model.protocol.startsWith('mirabox-') && model.id !== 'mirabox-293s',
)) {
  await test(`${modelId} retains STP after every image`, async () => {
    await open(modelId);
    for (let i = 0; i < 3; i++) sendImage(1, new Uint8Array(20));
    await waitFor(() => stpCount() >= 3);
    assert.equal(stpCount(), 3);
  });
}

summaryExit();
