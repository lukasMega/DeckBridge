import assert from 'tjs:assert';
import { encodeDeckFrame } from '../src/web/server/virtual-deck/frame-codec.js';
import { FrameQueue, type QueueItem } from '../src/web/server/virtual-deck/frame-queue.js';
import { HeldKeys } from '../src/web/server/virtual-deck/held-keys.js';
import { InputFreshness, LatencyWindow } from '../src/web/server/virtual-deck/input-freshness.js';
import { PairingCodes } from '../src/web/server/virtual-deck/pairing-codes.js';
import {
  DECK_MAX_IN_FLIGHT,
  PAIRING_MAX_FAILS,
  PAIRING_TTL_MS,
} from '../src/web/server/virtual-deck/deck-constants.js';
import { test, summary } from './helpers/harness.js';

const frame = (key: number, tag = 0): QueueItem => ({
  kind: 'frame',
  key,
  bytes: new Uint8Array([tag]),
});

console.log('\ndeck frame codec');

test('encodeDeckFrame: 4-byte header then the image', () => {
  const out = encodeDeckFrame(14, new Uint8Array([9, 8, 7]), 'bmp');
  assert.deepEqual([...out], [1, 14, 1, 0, 9, 8, 7]);
  assert.deepEqual([...encodeDeckFrame(0, new Uint8Array(0), 'jpeg')], [1, 0, 0, 0]);
});

console.log('\ndeck frame queue');

test('sends under the window, the next frame waits, ack drains in key order', () => {
  const sent: QueueItem[] = [];
  const q = new FrameQueue(DECK_MAX_IN_FLIGHT, (i) => sent.push(i));
  for (let k = 0; k < DECK_MAX_IN_FLIGHT; k++) q.push(frame(k));
  assert.equal(sent.length, DECK_MAX_IN_FLIGHT);
  q.push(frame(14));
  q.push(frame(7));
  assert.equal(sent.length, DECK_MAX_IN_FLIGHT);
  assert.equal(q.pendingCount, 2);
  q.ack(1);
  assert.equal(sent.at(-1)!.key, 7, 'lowest pending key first');
  assert.equal(sent.length, DECK_MAX_IN_FLIGHT + 1);
  q.ack(DECK_MAX_IN_FLIGHT + 1);
  assert.equal(sent.at(-1)!.key, 14);
});

test('a newer frame for a pending key replaces it; the stale one is never sent', () => {
  const sent: QueueItem[] = [];
  const q = new FrameQueue(1, (i) => sent.push(i));
  q.push(frame(0, 1));
  q.push(frame(3, 2));
  q.push(frame(3, 3));
  q.ack(1);
  const tags = sent.map((i) => (i.kind === 'frame' ? i.bytes[0] : -1));
  assert.deepEqual(tags, [1, 3]);
});

test('ack above sent is clamped', () => {
  const q = new FrameQueue(2, () => {});
  q.push(frame(0));
  q.ack(99);
  assert.equal(q.inFlight, 0);
  q.push(frame(1));
  q.push(frame(2));
  q.push(frame(3));
  assert.equal(q.inFlight, 2, 'clamping must not widen the window');
});

test('a clear replaces a pending frame and does not use the window', () => {
  const sent: QueueItem[] = [];
  const q = new FrameQueue(1, (i) => sent.push(i));
  q.push(frame(0));
  q.push(frame(5));
  q.push({ kind: 'clear', key: 5 });
  assert.equal(sent.length, 2);
  assert.equal(sent[1]!.kind, 'clear');
  assert.equal(q.inFlight, 1);
  assert.equal(q.pendingCount, 0);
});

console.log('\ndeck held keys');

test('single session down/up forward both', () => {
  const h = new HeldKeys();
  assert.equal(h.down('a', 3), true);
  assert.equal(h.down('a', 3), false, 'repeat down is not a transition');
  assert.equal(h.up('a', 3), true);
  assert.equal(h.isHeld(3), false);
});

test('two sessions on one key: one down, one up after both release', () => {
  const h = new HeldKeys();
  assert.equal(h.down('a', 1), true);
  assert.equal(h.down('b', 1), false);
  assert.equal(h.up('a', 1), false);
  assert.equal(h.isHeld(1), true);
  assert.equal(h.up('b', 1), true);
});

test('releaseSession returns exactly the keys that became free; stray up ignored', () => {
  const h = new HeldKeys();
  h.down('a', 1);
  h.down('a', 2);
  h.down('b', 2);
  assert.deepEqual(h.releaseSession('a'), [1]);
  assert.equal(h.isHeld(2), true);
  assert.equal(h.up('a', 2), false, 'a no longer holds 2');
  assert.equal(h.up('c', 9), false);
});

console.log('\ndeck input freshness');

test('constant offset: lateness 0; one delayed message shows its delay', () => {
  const f = new InputFreshness();
  f.sample(1000, 5000);
  for (let t = 1; t <= 5; t++) {
    assert.equal(f.lateness(1000 + t * 100, 5000 + t * 100), 0);
    f.sample(1000 + t * 100, 5000 + t * 100);
  }
  assert.equal(f.lateness(2000, 2000 + 4000 + 4210), 4210);
});

test('lateness with no baseline is 0', () => {
  assert.equal(new InputFreshness().lateness(10, 99999), 0);
});

test('slow clock drift over 10 minutes never looks late', () => {
  const f = new InputFreshness();
  let worst = 0;
  for (let s = 0; s <= 600; s++) {
    const server = s * 1000;
    const client = server * 0.999; // client clock 0.1% slow: offset grows 1 ms/s
    worst = Math.max(worst, f.lateness(client, server));
    f.sample(client, server);
  }
  assert.ok(worst <= 60, `worst lateness ${worst}`);
});

test('LatencyWindow percentiles and the 200-sample cap', () => {
  const w = new LatencyWindow();
  assert.equal(w.p95(), undefined);
  for (let i = 1; i <= 100; i++) w.add(i);
  assert.equal(w.p50(), 50);
  assert.equal(w.p95(), 95);
  for (let i = 0; i < 300; i++) w.add(7);
  assert.equal(w.count, 200);
  assert.equal(w.p95(), 7);
});

console.log('\ndeck pairing codes');

test('code and shortCode each consume once', () => {
  const p = new PairingCodes();
  const a = p.create(0);
  assert.equal(p.consume({ code: a.code }, 1), 'ok');
  assert.equal(p.consume({ code: a.code }, 2), 'none');
  const b = p.create(10);
  assert.equal(p.consume({ shortCode: b.shortCode }, 11), 'ok');
});

test('shortCode is always 6 digits, code is 32 base32 chars', () => {
  const p = new PairingCodes();
  for (let i = 0; i < 300; i++) {
    const c = p.create(0);
    assert.ok(/^\d{6}$/.test(c.shortCode), c.shortCode);
    assert.ok(/^[A-Z2-7]{32}$/.test(c.code), c.code);
  }
});

test('expires at the TTL', () => {
  const p = new PairingCodes();
  const c = p.create(1000);
  assert.equal(p.consume({ code: c.code }, 1000 + PAIRING_TTL_MS + 1), 'expired');
  assert.equal(p.pending(1000 + PAIRING_TTL_MS + 1), null);
});

test('wrong guesses invalidate the pending pairing at the limit', () => {
  const p = new PairingCodes();
  const c = p.create(0);
  const wrong = c.shortCode === '000000' ? '000001' : '000000';
  for (let i = 0; i < PAIRING_MAX_FAILS; i++) {
    assert.equal(p.consume({ shortCode: wrong }, 1), 'invalid');
  }
  assert.equal(p.consume({ shortCode: c.shortCode }, 2), 'none');
});

test('create replaces the pending pairing', () => {
  const p = new PairingCodes();
  const a = p.create(0);
  const b = p.create(0);
  assert.equal(p.consume({ code: a.code }, 1), 'invalid');
  assert.equal(p.consume({ code: b.code }, 2), 'ok');
});

summary();
