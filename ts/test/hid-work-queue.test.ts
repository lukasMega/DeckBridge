import assert from 'tjs:assert';
import {
  DEFAULT_WORK_BUDGETS,
  HidWorkQueue,
  type WorkBudgets,
} from '../src/worker/hid-work-queue-host.js';
import type { MainToWorker } from '../src/worker/hid-worker-protocol.js';
import { test, summary } from './helpers/harness.js';

type Sent = MainToWorker & { id: number };
const BUDGETS: WorkBudgets = {
  postedCount: 3,
  postedBytes: 300,
  pendingCount: 5,
  pendingBytes: 500,
  controlReserve: 2,
};

function setup(budgets = BUDGETS): { q: HidWorkQueue; sent: Sent[]; ack: (n?: number) => void } {
  const sent: Sent[] = [];
  const q = new HidWorkQueue((m) => sent.push(m), budgets);
  let acked = 0;
  // Acknowledge the oldest `n` unacknowledged posts, like the worker does.
  const ack = (n = 1): void => {
    const ids = sent.slice(acked, acked + n).map((m) => m.id);
    acked += ids.length;
    q.complete(ids);
  };
  return { q, sent, ack };
}

const image = (keyIndex: number, size = 10, fill = 0): MainToWorker => ({
  type: 'image',
  keyIndex,
  bytes: new Uint8Array(size).fill(fill),
  format: 'jpeg',
});
const submitImage = (q: HidWorkQueue, keyIndex: number, size = 10, fill = 0) =>
  q.submit(image(keyIndex, size, fill), {
    kind: 'image',
    bytes: size,
    coalesceKey: `k${keyIndex}`,
  });
const submitTouch = (q: HidWorkQueue, n: number) =>
  q.submit(
    { type: 'touchImage', bytes: new Uint8Array([n]), region: { x: n, y: 0, w: 1, h: 1 } },
    { kind: 'touch', bytes: 1 },
  );

test('paused worker + 10,000 frames on 4 keys: bounded throughout, newest per key wins', () => {
  const budgets = DEFAULT_WORK_BUDGETS;
  const { q, sent, ack } = setup(budgets);
  for (let i = 0; i < 10_000; i++) {
    assert.notEqual(submitImage(q, i % 4, 20 * 1024, i % 256), 'rejected');
    assert.ok(q.postedCount <= 15 && q.inFlightBytes <= budgets.postedBytes);
    assert.ok(q.pendingCount <= 64 && q.pendingBytes <= budgets.pendingBytes);
  }
  assert.equal(q.pendingCount, 4, 'one waiting frame per key');
  assert.ok(q.stats.coalesced >= 10_000 - 15 - 4);
  while (q.postedCount > 0) ack();
  const last = new Map<number, number>();
  for (const m of sent) if (m.type === 'image') last.set(m.keyIndex, m.bytes[0]!);
  // Frames 9996..9999 were the last for keys 0..3.
  assert.deepEqual(
    [...last.entries()].toSorted((a, b) => a[0] - b[0]),
    [
      [0, 9996 % 256],
      [1, 9997 % 256],
      [2, 9998 % 256],
      [3, 9999 % 256],
    ],
  );
});

test('a waiting frame is a snapshot the caller can no longer mutate', () => {
  const { q, sent, ack } = setup();
  for (let k = 0; k < 3; k++) submitImage(q, k);
  const bytes = new Uint8Array([1, 2, 3]);
  const msg: MainToWorker = { type: 'image', keyIndex: 9, bytes, format: 'jpeg' };
  q.submit(msg, {
    kind: 'image',
    bytes: 3,
    snapshot: () => ({ ...msg, bytes: bytes.slice() }),
  });
  bytes[0] = 99;
  ack();
  const posted = sent.at(-1)!;
  assert.equal(posted.type, 'image');
  assert.equal((posted as { bytes: Uint8Array }).bytes[0], 1);
});

test('strip patches stay FIFO and overflow is rejected, never dropped silently', () => {
  const { q, sent, ack } = setup();
  for (let n = 0; n < 8; n++) assert.notEqual(submitTouch(q, n), 'rejected');
  assert.equal(submitTouch(q, 8), 'rejected', 'pending count budget');
  while (q.postedCount > 0) ack();
  const order = sent.map((m) => (m.type === 'touchImage' ? m.region!.x : -1));
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('controls are barriers: an image never coalesces across one', () => {
  const { q, sent, ack } = setup();
  for (let k = 0; k < 3; k++) submitImage(q, k); // fill posting
  submitImage(q, 5, 10, 1);
  q.submit({ type: 'clearKey', keyIndex: 5 }, { kind: 'control', bytes: 0 });
  assert.equal(submitImage(q, 5, 10, 2), 'queued', 'not coalesced across the clear');
  assert.equal(submitImage(q, 5, 10, 3), 'coalesced', 'coalesced within the trailing images');
  while (q.postedCount > 0) ack();
  const tail = sent.slice(3).map((m) => (m.type === 'image' ? `img${m.bytes[0]}` : m.type));
  assert.deepEqual(tail, ['img1', 'clearKey', 'img3']);
});

test('byte budgets bind as well as counts; an image over the posted budget is rejected', () => {
  const { q } = setup();
  assert.equal(submitImage(q, 0, 301), 'rejected');
  assert.equal(submitImage(q, 0, 200), 'posted');
  assert.equal(submitImage(q, 1, 200), 'queued', 'posted bytes full at 400 > 300');
  assert.equal(submitImage(q, 2, 300), 'queued', 'pending bytes reach exactly 500');
  assert.equal(submitImage(q, 3, 1), 'rejected', 'one byte over the pending budget');
});

test('controls keep a reserve beyond a full frame backlog, then they are refused too', () => {
  const { q } = setup();
  for (let n = 0; n < 8; n++) submitTouch(q, n); // 3 posted + 5 waiting = full
  assert.equal(submitTouch(q, 8), 'rejected');
  const ctl = (): string =>
    q.submit({ type: 'setBrightness', level: 1 }, { kind: 'control', bytes: 0 });
  assert.equal(ctl(), 'queued');
  assert.equal(ctl(), 'queued');
  assert.equal(ctl(), 'rejected', 'the reserve is bounded too');
});

test('postMessage throwing returns the credit', () => {
  let fail = true;
  const q = new HidWorkQueue(() => {
    if (fail) throw new Error('worker gone');
  }, BUDGETS);
  assert.equal(submitImage(q, 0), 'failed');
  assert.equal(q.postedCount, 0);
  assert.equal(q.inFlightBytes, 0);
  fail = false;
  assert.equal(submitImage(q, 0), 'posted');
});

test('stale and duplicate completions are ignored; reset forgets the generation', () => {
  const { q, sent } = setup();
  submitImage(q, 0);
  submitImage(q, 1);
  const [a] = sent;
  q.complete([a!.id, a!.id, 12345]);
  assert.equal(q.postedCount, 1);
  q.reset();
  assert.equal(q.postedCount, 0);
  assert.equal(q.pendingCount, 0);
  submitImage(q, 2);
  const fresh = sent.at(-1)!;
  q.complete([sent[1]!.id]); // old generation's id
  assert.equal(q.postedCount, 1);
  assert.ok(fresh.id > sent[1]!.id, 'ids are never reused');
});

test('multiple keys do not starve once the writer resumes', () => {
  const { q, sent, ack } = setup();
  for (let round = 0; round < 50; round++) for (let k = 0; k < 4; k++) submitImage(q, k, 10, round);
  while (q.postedCount > 0) ack();
  const keys = new Set(sent.slice(3).map((m) => (m.type === 'image' ? m.keyIndex : -1)));
  assert.deepEqual(
    [...keys].toSorted((a, b) => a - b),
    [0, 1, 2, 3],
  );
});

summary();
