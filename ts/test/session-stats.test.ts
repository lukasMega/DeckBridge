import assert from 'tjs:assert';
import { ACTIVITY_BUCKETS, SessionStats } from '../src/web/server/session-stats.js';
import { test, summary } from './helpers/harness.js';

const MIN = 60_000;
const T0 = 1_000 * MIN; // minute-aligned, so bucket edges are exact

function setup() {
  const clock = { t: T0 };
  const stats = new SessionStats(() => clock.t);
  return { clock, stats };
}

function deck(s: SessionStats, key = 'a', hasEncoders = false): void {
  s.deckConnected(key, `Model ${key}`, 'usb', hasEncoders);
}

console.log('\nSessionStats');

test('down counts once, up does not count', () => {
  const { stats } = setup();
  deck(stats);
  stats.key('a', 'R1 C1', 'down');
  stats.key('a', 'R1 C1', 'up');
  const snap = stats.snapshot();
  assert.equal(snap.totals.keyPresses, 1);
  assert.equal(snap.decks[0]!.keyPresses, 1);
  assert.deepEqual(snap.decks[0]!.keys, [{ label: 'R1 C1', count: 1 }]);
});

test('a second down without an up is ignored', () => {
  const { stats } = setup();
  deck(stats);
  stats.key('a', 'R1 C1', 'down');
  stats.key('a', 'R1 C1', 'down');
  assert.equal(stats.snapshot().totals.keyPresses, 1);
  stats.key('a', 'R1 C1', 'up');
  stats.key('a', 'R1 C1', 'down');
  assert.equal(stats.snapshot().totals.keyPresses, 2);
});

test('reattach clears the pressed set', () => {
  const { stats } = setup();
  deck(stats);
  stats.key('a', 'R1 C1', 'down');
  deck(stats); // unplugged while held: no up ever arrives
  stats.key('a', 'R1 C1', 'down');
  assert.equal(stats.snapshot().totals.keyPresses, 2);
});

test('reconnects count only for a seen key', () => {
  const { stats } = setup();
  deck(stats, 'a');
  assert.equal(stats.snapshot().totals.reconnects, 0);
  deck(stats, 'b');
  assert.equal(stats.snapshot().totals.reconnects, 0);
  deck(stats, 'a');
  const snap = stats.snapshot();
  assert.equal(snap.totals.reconnects, 1);
  assert.equal(snap.decks[0]!.reconnects, 1);
  assert.equal(snap.decks[1]!.reconnects, 0);
});

test('reconnect refreshes model, source and encoders', () => {
  const { stats } = setup();
  stats.deckConnected('a', 'Old', 'usb', false);
  stats.deckConnected('a', 'New', 'mock', true);
  const d = stats.snapshot().decks[0]!;
  assert.equal(d.modelName, 'New');
  assert.equal(d.source, 'mock');
  assert.equal(d.hasEncoders, true);
});

test('activity: partial last bucket and minute rollover', () => {
  const { clock, stats } = setup();
  deck(stats);
  stats.key('a', 'k', 'down');
  stats.key('a', 'k', 'up');
  clock.t += MIN;
  stats.key('a', 'k', 'down');
  stats.key('a', 'k', 'up');
  stats.key('a', 'k', 'down');
  stats.key('a', 'k', 'up');
  const a = stats.snapshot().totals.activity;
  assert.equal(a.length, ACTIVITY_BUCKETS);
  assert.deepEqual(a.slice(-2), [1, 2]);
  assert.equal(
    a.slice(0, -2).every((n) => n === 0),
    true,
  );
  assert.deepEqual(stats.snapshot().decks[0]!.activity.slice(-2), [1, 2]);
});

test('activity: snapshot alone advances the ring', () => {
  const { clock, stats } = setup();
  deck(stats);
  stats.key('a', 'k', 'down');
  clock.t += 3 * MIN;
  const a = stats.snapshot().totals.activity;
  assert.deepEqual(a.slice(-4), [1, 0, 0, 0]);
});

test('activity: a gap of 15 minutes or more zeros the ring', () => {
  const { clock, stats } = setup();
  deck(stats);
  stats.key('a', 'k', 'down');
  clock.t += ACTIVITY_BUCKETS * MIN;
  assert.equal(
    stats.snapshot().totals.activity.every((n) => n === 0),
    true,
  );
  assert.equal(stats.snapshot().totals.keyPresses, 1);
});

test('eviction at the 17th deck keeps totals', () => {
  const { clock, stats } = setup();
  for (let i = 0; i < 16; i++) {
    clock.t += 1000;
    deck(stats, `d${i}`);
    stats.key(`d${i}`, 'k', 'down');
  }
  clock.t += 1000;
  stats.key('d0', 'k', 'up'); // d0 is now fresher than d1
  clock.t += 1000;
  deck(stats, 'new');
  const snap = stats.snapshot();
  assert.equal(snap.decks.length, 16);
  assert.equal(
    snap.decks.some((d) => d.deviceKey === 'd1'),
    false,
  );
  assert.equal(
    snap.decks.some((d) => d.deviceKey === 'd0'),
    true,
  );
  assert.equal(snap.totals.keyPresses, 16);
});

test('dial: presses count down edges, detents use abs', () => {
  const { stats } = setup();
  deck(stats, 'a', true);
  stats.dialPress('a', 'down');
  stats.dialPress('a', 'up');
  stats.dialRotate('a', 3);
  stats.dialRotate('a', -2);
  const d = stats.snapshot().decks[0]!;
  assert.equal(d.dialPresses, 1);
  assert.equal(d.dialDetents, 5);
  assert.equal(stats.snapshot().totals.dialDetents, 5);
});

test('images: processed and cache hits, imagesTotal', () => {
  const { stats } = setup();
  deck(stats);
  stats.imageProcessed('a', false);
  stats.imageProcessed('a', true);
  stats.imageProcessed('a', true);
  const d = stats.snapshot().decks[0]!;
  assert.equal(d.imagesProcessed, 3);
  assert.equal(d.cacheHits, 2);
  assert.equal(stats.imagesTotal(), 3);
});

test('an empty deviceKey is ignored', () => {
  const { stats } = setup();
  stats.deckConnected('', 'x', 'usb', false);
  stats.key('', 'k', 'down');
  stats.dialPress('', 'down');
  stats.dialRotate('', 1);
  stats.imageProcessed('', true);
  const snap = stats.snapshot();
  assert.equal(snap.decks.length, 0);
  assert.equal(snap.totals.keyPresses, 0);
  assert.equal(stats.imagesTotal(), 0);
});

test('an unseen key gets a defensive record', () => {
  const { stats } = setup();
  stats.key('zz', 'k', 'down');
  const d = stats.snapshot().decks[0]!;
  assert.equal(d.modelName, 'zz');
  assert.equal(d.source, 'usb');
  assert.equal(d.hasEncoders, false);
  assert.equal(stats.snapshot().totals.reconnects, 0);
});

test('top keys sort by count desc, then label', () => {
  const { stats } = setup();
  deck(stats);
  for (const [label, n] of [
    ['b', 2],
    ['a', 2],
    ['c', 3],
  ] as const) {
    for (let i = 0; i < n; i++) {
      stats.key('a', label, 'down');
      stats.key('a', label, 'up');
    }
  }
  assert.deepEqual(
    stats.snapshot().decks[0]!.keys.map((k) => k.label),
    ['c', 'a', 'b'],
  );
});

test('uptime and startedAt come from the clock', () => {
  const { clock, stats } = setup();
  clock.t += 5000;
  const snap = stats.snapshot();
  assert.equal(snap.startedAt, T0);
  assert.equal(snap.at, T0 + 5000);
  assert.equal(snap.uptimeMs, 5000);
});

test('snapshot is a copy', () => {
  const { stats } = setup();
  deck(stats);
  stats.key('a', 'k', 'down');
  const snap = stats.snapshot();
  snap.totals.keyPresses = 99;
  snap.totals.activity[ACTIVITY_BUCKETS - 1] = 99;
  snap.decks[0]!.keys.length = 0;
  snap.decks[0]!.activity[0] = 99;
  const again = stats.snapshot();
  assert.equal(again.totals.keyPresses, 1);
  assert.equal(again.totals.activity[ACTIVITY_BUCKETS - 1], 1);
  assert.equal(again.decks[0]!.keys.length, 1);
  assert.equal(again.decks[0]!.activity[0], 0);
});

summary();
