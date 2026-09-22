import assert from 'tjs:assert';
import { Akp05Driver } from '../src/devices/ajazz/akp05-driver.js';
import type { MainToWorker, WorkerToMain } from '../src/hid-worker-protocol.js';
import { testAsync as test, summaryExit } from './helpers/harness.js';
import { SOLID_RED_16X16_JPEG } from './helpers/fixtures.js';

type Io = { op: 'send'; wireId: number; bytes: Uint8Array } | { op: 'clear'; wireId: number };
const io: Io[] = [];
const messages: WorkerToMain[] = [];
let receive: ((ev: MessageEvent) => void) | undefined;
const scope = globalThis as unknown as {
  postMessage: (msg: WorkerToMain) => void;
  addEventListener: (type: string, callback: (ev: MessageEvent) => void) => void;
};
scope.postMessage = (msg) => messages.push(msg);
scope.addEventListener = (_type, callback) => {
  receive = callback;
};

// Record device I/O instead of claiming USB; the strip split + transform stay real.
Object.assign(Akp05Driver.prototype, {
  open: () => Promise.resolve(),
  close: () => Promise.resolve(),
  sendImage: (wireId: number, bytes: Uint8Array) => io.push({ op: 'send', wireId, bytes }),
  clearKey: (wireId: number) => io.push({ op: 'clear', wireId }),
});
await import('../src/hid-worker.js');

function send(msg: MainToWorker): void {
  receive!({ data: msg } as MessageEvent);
}
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const ops = (): string[] => io.map((e) => `${e.op}:${e.wireId}`);

async function openAkp05e(): Promise<void> {
  send({ type: 'open', modelId: 'ajazz-akp05e' });
  await wait(5);
  io.length = 0;
  messages.length = 0;
}

/** A 16-px partial-window frame at `x` lands on exactly one 200-px strip segment. */
function paintSegment(x: number): void {
  send({ type: 'touchImage', bytes: SOLID_RED_16X16_JPEG, region: { x, y: 0, w: 16, h: 16 } });
}

console.log('\nhid-worker: touch-strip mask');

await test('unmasked strip segments are sent', async () => {
  await openAkp05e();
  paintSegment(0);
  paintSegment(200);
  await wait(5);
  assert.deepEqual(ops(), ['send:1', 'send:2']);
});

await test('masked segments are withheld; the rest still go out', async () => {
  await openAkp05e();
  send({ type: 'setTouchStripMask', wireIds: [1] });
  paintSegment(0);
  paintSegment(200);
  await wait(5);
  assert.deepEqual(ops(), ['send:2']);
});

await test('unmask resends the cached Elgato segment, or clears an unpainted zone', async () => {
  await openAkp05e();
  send({ type: 'setTouchStripMask', wireIds: [1, 3] });
  paintSegment(0); // cached for wire 1, not sent
  await wait(5);
  assert.deepEqual(ops(), []);
  send({ type: 'setTouchStripMask', wireIds: [] });
  await wait(5);
  assert.deepEqual(ops(), ['send:1', 'clear:3']);
  assert.ok(io[0]!.op === 'send' && io[0]!.bytes.length > 0, 'cached native bytes resent');
});

await test('zones staying in the mask are left alone', async () => {
  await openAkp05e();
  send({ type: 'setTouchStripMask', wireIds: [1, 2] });
  send({ type: 'setTouchStripMask', wireIds: [2, 4] });
  await wait(5);
  assert.deepEqual(ops(), ['clear:1']);
});

await test('reopen resets the mask and the segment cache', async () => {
  await openAkp05e();
  send({ type: 'setTouchStripMask', wireIds: [1] });
  paintSegment(0);
  await wait(5);
  await openAkp05e();
  paintSegment(0);
  send({ type: 'setTouchStripMask', wireIds: [2] });
  send({ type: 'setTouchStripMask', wireIds: [] });
  await wait(5);
  assert.deepEqual(ops(), ['send:1', 'clear:2'], 'wire 1 unmasked after open; nothing stale');
});

await test('after close, releasing masked zones does no device I/O', async () => {
  await openAkp05e();
  send({ type: 'setTouchStripMask', wireIds: [1] });
  send({ type: 'close' });
  await wait(5);
  assert.ok(messages.some((m) => m.type === 'closed'));
  send({ type: 'setTouchStripMask', wireIds: [] });
  await wait(5);
  assert.deepEqual(ops(), []);
});

summaryExit();
