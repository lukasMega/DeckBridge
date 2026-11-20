import assert from 'tjs:assert';
import { Akp05Driver } from '../src/devices/ajazz/akp05-driver.js';
import { UlanziDriver } from '../src/devices/ulanzi/ulanzi-driver.js';
import type { MainToWorker, WorkMessage, WorkerToMain } from '../src/worker/hid-worker-protocol.js';
import { testAsync as test, summaryExit } from './helpers/harness.js';
import { SOLID_RED_16X16_JPEG } from './helpers/fixtures.js';
import { hashJpeg } from '../src/shared/image-hash.js';

type Io = { op: 'send'; wireId: number; bytes: Uint8Array } | { op: 'clear'; wireId: number };
/** SOF0 width of a baseline JPEG: 800 = a full-strip upload, 176 = one slot. */
function jpegWidth(jpeg: Uint8Array): number {
  for (let i = 0; i < jpeg.length - 8; i++) {
    if (jpeg[i] === 0xff && jpeg[i + 1] === 0xc0) return (jpeg[i + 7]! << 8) | jpeg[i + 8]!;
  }
  throw new Error('no SOF0 marker');
}
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
await import('../src/worker/hid-worker.js');

function send(msg: MainToWorker): void {
  receive!({ data: msg } as MessageEvent);
}
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const ops = (): string[] => io.map((e) => `${e.op}:${e.wireId}`);

async function openAkp05e(): Promise<void> {
  send({ type: 'open', modelId: 'ajazz-akp05e', hidPath: 'fake' });
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

await test('unmask redraws the released zones from the strip canvas', async () => {
  await openAkp05e();
  send({ type: 'setTouchStripMask', wireIds: [1, 3] });
  paintSegment(0); // drawn for wire 1, not sent
  await wait(5);
  assert.deepEqual(ops(), []);
  send({ type: 'setTouchStripMask', wireIds: [] });
  await wait(5);
  assert.deepEqual(ops(), ['send:1', 'send:3']);
  assert.ok(
    io.every((e) => e.op === 'send' && jpegWidth(e.bytes) === 176),
    'one slot each',
  );
});

await test('restoreTouchSegments redraws those zones; all of them is one full-strip upload', async () => {
  await openAkp05e();
  paintSegment(0);
  await wait(5);
  io.length = 0;
  send({ type: 'restoreTouchSegments', wireIds: [1, 2] });
  send({ type: 'restoreTouchSegments', wireIds: [1, 2, 3, 4] });
  await wait(5);
  assert.deepEqual(ops(), ['send:1', 'send:2', 'send:1']);
  const last = io[2] as { bytes: Uint8Array };
  assert.equal(jpegWidth(last.bytes), 800);
});

await test('a full window is one full-strip upload at wire 1', async () => {
  await openAkp05e();
  send({ type: 'touchImage', bytes: SOLID_RED_16X16_JPEG });
  await wait(5);
  assert.deepEqual(ops(), ['send:1']);
  assert.equal(jpegWidth((io[0] as { bytes: Uint8Array }).bytes), 800);
});

await test("setTouchStripOptions 'always' makes a patch a full-strip upload until reopen", async () => {
  await openAkp05e();
  send({ type: 'setTouchStripOptions', options: { zoneFit: 'crop', upload: 'always' } });
  paintSegment(416);
  await wait(5);
  assert.equal(jpegWidth((io[0] as { bytes: Uint8Array }).bytes), 800);
  await openAkp05e();
  paintSegment(416);
  await wait(5);
  assert.deepEqual(ops(), ['send:3'], 'defaults again after open');
});

await test('a partial window re-sends its whole zone, drawn on the last frame', async () => {
  await openAkp05e();
  paintSegment(0);
  paintSegment(100);
  await wait(5);
  assert.deepEqual(ops(), ['send:1', 'send:1']);
  const [first, second] = io as Array<{ bytes: Uint8Array }>;
  const same =
    first!.bytes.length === second!.bytes.length &&
    first!.bytes.every((b, i) => b === second!.bytes[i]);
  assert.ok(!same, 'second frame keeps the first patch');
});

await test('zones staying in the mask are left alone', async () => {
  await openAkp05e();
  send({ type: 'setTouchStripMask', wireIds: [1, 2] });
  send({ type: 'setTouchStripMask', wireIds: [2, 4] });
  await wait(5);
  assert.deepEqual(ops(), ['send:1']);
});

await test('reopen resets the mask and the strip canvas', async () => {
  await openAkp05e();
  send({ type: 'setTouchStripMask', wireIds: [1] });
  paintSegment(0);
  await wait(5);
  await openAkp05e();
  paintSegment(0);
  send({ type: 'setTouchStripMask', wireIds: [2] });
  send({ type: 'setTouchStripMask', wireIds: [] });
  await wait(5);
  assert.deepEqual(ops(), ['send:1', 'send:2'], 'wire 1 unmasked after open');
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

console.log('\nhid-worker: info window');

const smallWindow: string[] = [];
const hostStats: string[] = [];
Object.assign(UlanziDriver.prototype, {
  open: () => Promise.resolve(),
  close: () => Promise.resolve(),
  setSmallWindow: (mode: number, hourFormat: string) => smallWindow.push(`${mode}/${hourFormat}`),
  setHostStats: (cpu: number, mem: number, gpu: number) => hostStats.push(`${cpu}/${mem}/${gpu}`),
});

await test('setSmallWindow reaches a driver that has it and is ignored by one that does not', async () => {
  send({ type: 'open', modelId: 'ulanzi-d200', hidPath: 'fake' });
  await wait(5);
  send({ type: 'setSmallWindow', mode: 0, hourFormat: '12H' });
  await wait(5);
  assert.deepEqual(smallWindow, ['0/12H']);
  await openAkp05e();
  send({ type: 'setSmallWindow', mode: 1, hourFormat: '24H' });
  await wait(5);
  assert.deepEqual(smallWindow, ['0/12H'], 'the AKP05 driver has no info window');
  assert.ok(!messages.some((m) => m.type === 'error'));
});

await test('setHostStats reaches a driver that has it and is ignored by one that does not', async () => {
  send({ type: 'open', modelId: 'ulanzi-d200', hidPath: 'fake' });
  await wait(5);
  send({ type: 'setHostStats', cpu: 12, mem: 34, gpu: 56 });
  await wait(5);
  assert.deepEqual(hostStats, ['12/34/56']);
  await openAkp05e();
  send({ type: 'setHostStats', cpu: 1, mem: 2, gpu: 3 });
  await wait(5);
  assert.deepEqual(hostStats, ['12/34/56'], 'the AKP05 driver has no info window');
  assert.ok(!messages.some((m) => m.type === 'error'));
});

console.log('\nhid-worker: frame hash');

await test("an 'image' message carries the frame hash in workDone.sent", async () => {
  await openAkp05e();
  send({
    type: 'image',
    keyIndex: 2,
    bytes: SOLID_RED_16X16_JPEG,
    format: 'jpeg',
    id: 7,
  } as WorkMessage);
  await wait(20);
  assert.deepEqual(
    messages.filter((m) => m.type === 'workDone'),
    [
      {
        type: 'workDone',
        ids: [7],
        sent: [{ keyIndex: 2, hash: hashJpeg(SOLID_RED_16X16_JPEG), cached: false }],
      },
    ],
    'credit and sent notification travel in one message',
  );
  assert.ok(!messages.some((m) => (m as { type: string }).type === 'imageSent'));
});

await test('a failed or skipped image credits its id with no sent notification', async () => {
  // No open: the worker has no driver, so the frame is skipped.
  send({ type: 'close' });
  await wait(10);
  messages.length = 0;
  send({
    type: 'image',
    keyIndex: 1,
    bytes: SOLID_RED_16X16_JPEG,
    format: 'jpeg',
    id: 9,
  } as WorkMessage);
  await wait(20);
  assert.deepEqual(
    messages.filter((m) => m.type === 'workDone'),
    [{ type: 'workDone', ids: [9], sent: [] }],
  );
});

summaryExit();
