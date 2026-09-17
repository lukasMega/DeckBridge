import assert from 'tjs:assert';
import { MiraboxDriver } from '../src/mirabox.js';
import { DEVICE_MODELS } from '../src/devices/registry.js';
import type { MainToWorker, WorkerToMain } from '../src/hid-worker-protocol.js';
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
await import('../src/hid-worker.js');

function send(msg: MainToWorker): void {
  receive!({ data: msg } as MessageEvent);
}
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const tag = (packet: Buffer): string => packet.subarray(6, 9).toString();
const stpCount = (): number => writes.filter((packet) => tag(packet) === 'STP').length;

async function open(modelId: string, batchImageTransfers?: boolean): Promise<void> {
  send({
    type: 'open',
    modelId,
    overrides: {
      image: { transform: 'passthrough' },
      ...(batchImageTransfers === undefined ? {} : { wire: { batchImageTransfers } }),
    },
  });
  await wait(5);
  writes.length = 0;
  messages.length = 0;
  notificationTags.length = 0;
}

await test('293S page sends 15 BATs and one final STP', async () => {
  await open('mirabox-293s');
  for (let keyIndex = 1; keyIndex <= 15; keyIndex++) {
    send({ type: 'sendImage', keyIndex, bytes: new Uint8Array(600) });
  }
  await wait(5);
  assert.equal(writes.filter((packet) => tag(packet) === 'BAT').length, 15);
  assert.equal(stpCount(), 1);
  assert.equal(tag(writes.at(-1)!), 'STP');
});

await test('isolated image flushes after fixed collection window', async () => {
  await open('mirabox-293s');
  send({ type: 'sendImage', keyIndex: 13, bytes: new Uint8Array(20) });
  await wait(5);
  assert.equal(writes.length, 0);
  await wait(25);
  assert.equal(stpCount(), 1);
});

await test('293S batching override disables collection and per-batch STP', async () => {
  await open('mirabox-293s', false);
  for (let i = 0; i < 3; i++) send({ type: 'sendImage', keyIndex: 13, bytes: new Uint8Array(20) });
  await wait(5);
  assert.equal(stpCount(), 3);
});

await test('293S rebadge batching can be enabled through tuning', async () => {
  await open('ajazz-akp153', true);
  for (let i = 0; i < 3; i++) send({ type: 'sendImage', keyIndex: 13, bytes: new Uint8Array(20) });
  await wait(5);
  assert.equal(writes.length, 0);
  await wait(25);
  assert.equal(stpCount(), 1);
});

await test('unsupported board ignores injected batching override', async () => {
  await open('mirabox-293', true);
  for (let i = 0; i < 3; i++) send({ type: 'sendImage', keyIndex: 1, bytes: new Uint8Array(20) });
  await wait(5);
  assert.equal(stpCount(), 3);
});

await test('CORA image completion notifications follow final STP', async () => {
  await open('mirabox-293s');
  for (let keyIndex = 0; keyIndex < 15; keyIndex++) {
    send({ type: 'image', keyIndex, bytes: new Uint8Array(20), format: 'jpeg' });
  }
  await wait(5);
  assert.equal(stpCount(), 1);
  assert.equal(notificationTags.length, 15);
  assert.ok(notificationTags.every((value) => value === 'STP'));
});

await test('page overflow receives another final STP', async () => {
  await open('mirabox-293s');
  for (let i = 0; i < 16; i++) {
    send({ type: 'sendImage', keyIndex: 13, bytes: new Uint8Array(20) });
  }
  await wait(30);
  assert.equal(stpCount(), 2);
});

await test('continuous arrivals cannot reset flush deadline', async () => {
  await open('mirabox-293s');
  for (let i = 0; i < 5; i++) {
    send({ type: 'sendImage', keyIndex: 13, bytes: new Uint8Array(20) });
    await wait(7);
  }
  assert.ok(stpCount() >= 1);
  await wait(25);
});

await test('clear and brightness follow committed images', async () => {
  await open('mirabox-293s');
  send({ type: 'sendImage', keyIndex: 13, bytes: new Uint8Array(20) });
  send({ type: 'clearKey', keyIndex: 13 });
  send({ type: 'setBrightness', level: 33 });
  await wait(5);
  assert.deepEqual(writes.map(tag), ['BAT', '\u0000\u0000\u0000', 'STP', 'CLE', 'LIG']);
});

await test('close commits images before disconnect sequence', async () => {
  await open('mirabox-293s');
  send({ type: 'sendImage', keyIndex: 13, bytes: new Uint8Array(20) });
  send({ type: 'close' });
  await wait(5);
  assert.equal(tag(writes[2]!), 'STP');
  assert.equal(tag(writes[3]!), 'CLE');
  assert.equal(tag(writes[4]!), 'HAN');
  assert.ok(messages.some((msg) => msg.type === 'closed'));
});

await test('transform failure still commits earlier images and releases queue', async () => {
  send({ type: 'open', modelId: 'mirabox-293s' });
  await wait(5);
  writes.length = 0;
  messages.length = 0;
  send({ type: 'sendImage', keyIndex: 13, bytes: new Uint8Array(20) });
  send({ type: 'image', keyIndex: 1, bytes: new Uint8Array([0]), format: 'jpeg' });
  send({ type: 'setBrightness', level: 33 });
  await wait(5);
  assert.equal(stpCount(), 1);
  assert.equal(tag(writes.at(-1)!), 'LIG');
  assert.ok(messages.some((msg) => msg.type === 'error'));
});

for (const { id: modelId } of DEVICE_MODELS.filter(
  (model) => model.driverKind === 'mirabox' && model.id !== 'mirabox-293s',
)) {
  await test(`${modelId} retains STP after every image`, async () => {
    await open(modelId);
    for (let i = 0; i < 3; i++) send({ type: 'sendImage', keyIndex: 1, bytes: new Uint8Array(20) });
    await wait(5);
    assert.equal(stpCount(), 3);
  });
}

summaryExit();
