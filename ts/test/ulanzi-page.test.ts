import assert from 'tjs:assert';
import { FlushScheduler, UlanziPage } from '../src/devices/ulanzi/ulanzi-page.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

function png(seed: number): Uint8Array {
  return new Uint8Array([seed, seed + 1, seed + 2]);
}

// ── page model ───────────────────────────────────────────────────────────────

console.log('\nulanzi-page: coalescing');

test('nothing staged means nothing to send', () => {
  const page = new UlanziPage(true);
  assert.equal(page.hasPending(), false);
  assert.equal(page.takeBatch(), null);
});

test('15 stages inside one window collapse into ONE batch', () => {
  const page = new UlanziPage(true);
  for (let i = 0; i < 15; i++) page.stage(i, png(i));
  const batch = page.takeBatch()!;
  assert.equal(batch.slots.length, 15);
  page.onFlushed(batch);
  assert.equal(page.takeBatch(), null, 'the batch must be consumed by onFlushed');
});

test('the last write for a slot wins', () => {
  const page = new UlanziPage(true);
  page.stage(4, png(1));
  page.stage(4, png(9));
  const batch = page.takeBatch()!;
  assert.equal(batch.slots.length, 1);
  assert.equal(batch.slots[0]!.png![0], 9);
});

test('batches are ordered by slot id regardless of stage order', () => {
  const page = new UlanziPage(true);
  page.stage(7, png(7));
  page.stage(2, png(2));
  page.stage(11, png(11));
  const ids = page.takeBatch()!.slots.map((s) => s.slotId);
  assert.equal(JSON.stringify(ids), '[2,7,11]');
});

console.log('\nulanzi-page: full vs partial');

test('the first flush after open is FULL, the next is PARTIAL', () => {
  const page = new UlanziPage(true);
  page.stage(0, png(0));
  page.stage(1, png(1));
  const first = page.takeBatch()!;
  assert.equal(first.full, true, 'the grid must be established with a full page');
  page.onFlushed(first);

  page.stage(1, png(5));
  const second = page.takeBatch()!;
  assert.equal(second.full, false);
  assert.equal(second.slots.length, 1, 'a partial page carries only what changed');
  assert.equal(second.slots[0]!.slotId, 1);
});

test('with partialUpdates off, every flush resends the whole remembered page', () => {
  const page = new UlanziPage(false);
  page.stage(0, png(0));
  page.stage(1, png(1));
  page.onFlushed(page.takeBatch()!);

  page.stage(1, png(5));
  const second = page.takeBatch()!;
  assert.equal(second.full, true);
  assert.equal(second.slots.length, 2, 'the untouched slot must be resent too');
  assert.equal(second.slots[1]!.png![0], 5, 'the changed slot must carry its new bytes');
});

test('restoreAll repaints everything remembered, even with nothing dirty', () => {
  const page = new UlanziPage(true);
  page.stage(0, png(0));
  page.stage(3, png(3));
  page.onFlushed(page.takeBatch()!);
  assert.equal(page.takeBatch(), null);

  page.restoreAll();
  const batch = page.takeBatch()!;
  assert.equal(batch.full, true);
  assert.equal(batch.slots.length, 2);
});

test('restoreAll on a page that has never flushed has nothing to repaint', () => {
  const page = new UlanziPage(true);
  page.restoreAll();
  assert.equal(page.takeBatch(), null);
});

test('a failed flush leaves the slots staged for the next attempt', () => {
  const page = new UlanziPage(true);
  page.stage(2, png(2));
  const batch = page.takeBatch()!;
  // onFlushed deliberately NOT called — the write threw.
  const retry = page.takeBatch()!;
  assert.equal(retry.slots.length, batch.slots.length);
  assert.equal(retry.slots[0]!.slotId, 2);
});

test('reset drops the remembered page (device closed)', () => {
  const page = new UlanziPage(true);
  page.stage(0, png(0));
  page.onFlushed(page.takeBatch()!);
  assert.equal(page.sentCount, 1);
  page.reset();
  assert.equal(page.sentCount, 0);
  assert.equal(page.takeBatch(), null);
});

// ── flush scheduler ──────────────────────────────────────────────────────────

console.log('\nulanzi-page: FlushScheduler');

/** Minimal deterministic timer: fires the earliest due callback on tick(). */
class FakeClock {
  now = 0;
  private seq = 0;
  private readonly pending = new Map<number, { at: number; fn: () => void }>();

  readonly setTimer = (fn: () => void, ms: number): unknown => {
    const id = this.seq++;
    this.pending.set(id, { at: this.now + ms, fn });
    return id;
  };

  readonly clearTimer = (h: unknown): void => {
    this.pending.delete(h as number);
  };

  /** Advance time, running every callback that comes due. */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let nextId: number | null = null;
      let nextAt = Infinity;
      for (const [id, t] of this.pending) {
        if (t.at <= target && t.at < nextAt) {
          nextAt = t.at;
          nextId = id;
        }
      }
      if (nextId === null) break;
      const entry = this.pending.get(nextId)!;
      this.pending.delete(nextId);
      this.now = entry.at;
      entry.fn();
    }
    this.now = target;
  }
}

function makeScheduler(
  clock: FakeClock,
  onFlush: () => void,
  debounceMs = 75,
  minIntervalMs = 120,
): FlushScheduler {
  return new FlushScheduler(
    {
      debounceMs,
      minIntervalMs,
      now: () => clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    },
    onFlush,
  );
}

test('a burst of schedules inside the debounce produces ONE flush', () => {
  const clock = new FakeClock();
  let flushes = 0;
  const s = makeScheduler(clock, () => flushes++);
  for (let i = 0; i < 15; i++) {
    s.schedule();
    clock.advance(1);
  }
  clock.advance(200);
  assert.equal(flushes, 1);
});

test('the flush waits out the debounce window', () => {
  const clock = new FakeClock();
  let flushes = 0;
  const s = makeScheduler(clock, () => flushes++);
  s.schedule();
  clock.advance(74);
  assert.equal(flushes, 0, 'must not fire before the debounce elapses');
  clock.advance(1);
  assert.equal(flushes, 1);
});

test('minFlushIntervalMs caps a 100 Hz stager at ~8 flushes/s', () => {
  const clock = new FakeClock();
  let flushes = 0;
  const s = makeScheduler(clock, () => flushes++);
  // 100 stages per second for one second.
  for (let i = 0; i < 100; i++) {
    s.schedule();
    clock.advance(10);
  }
  clock.advance(200);
  assert.ok(flushes <= 9, `expected <= 9 flushes in ~1 s, got ${flushes}`);
  assert.ok(flushes >= 5, `expected the scheduler to keep flushing, got ${flushes}`);
});

test('a lone schedule after a long idle still respects only the debounce', () => {
  const clock = new FakeClock();
  let flushes = 0;
  const s = makeScheduler(clock, () => flushes++);
  clock.advance(10_000);
  s.schedule();
  clock.advance(75);
  assert.equal(flushes, 1);
});

test('cancel disarms a pending flush', () => {
  const clock = new FakeClock();
  let flushes = 0;
  const s = makeScheduler(clock, () => flushes++);
  s.schedule();
  s.cancel();
  clock.advance(1000);
  assert.equal(flushes, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
tjs.exit(failed > 0 ? 1 : 0);
