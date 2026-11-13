import assert from 'tjs:assert';
import { PageTracker } from '../src/main/page-tracker.js';
import type { PageDefinition } from '../src/shared/page-config.js';
import type { PageObservation } from '../src/shared/page-match.js';
import { testAsync as test, summaryExit } from './helpers/harness.js';
import { FakeClock } from './helpers/fake-clock.js';
import { hashOf, makePage } from './helpers/pages.js';

console.log('\npage-tracker');

const A = makePage('p1', 'A', { name: 'Main' });
const B = makePage('p2', 'B');

function setup(pages: PageDefinition[] = [A, B]) {
  const clock = new FakeClock();
  const active: (PageDefinition | undefined)[] = [];
  const observations: PageObservation[] = [];
  const store = { pages };
  const geo = { profile: 'mk2', keyCount: 15, columns: 5 };
  const tracker = new PageTracker({
    pages: () => store.pages,
    geometry: () => geo,
    onActiveChange: (page) => active.push(page),
    onObservation: (obs) => observations.push(obs),
    clock,
  });
  /** One frame per key at the same instant: a page switch burst. */
  const send = (hashes: readonly (string | null)[], gap = 0): void => {
    hashes.forEach((h, key) => {
      if (h !== null) tracker.noteFrame(key, h);
      if (gap) clock.advance(gap);
    });
  };
  return {
    clock,
    active,
    observations,
    store,
    geo,
    tracker,
    send,
    last: () => observations.at(-1)!,
  };
}

await test('quiet commit: a burst commits once after the settle time', () => {
  const t = setup();
  t.send(A.hashes);
  t.clock.advance(50);
  assert.equal(t.active.length, 0, 'not before the burst is quiet');
  t.clock.advance(150);
  assert.deepEqual(
    t.active.map((p) => p?.id),
    ['p1'],
  );
  assert.equal(t.last().activePageId, 'p1');
  assert.equal(t.last().settling, false);
  assert.equal(t.clock.pending, 0, 'no timer left armed');
});

await test('a slow burst never flaps; the page commits once it goes quiet', () => {
  const t = setup();
  t.send(A.hashes);
  t.clock.advance(1000);
  t.active.length = 0;
  // Page B arrives a key every 100 ms: never quiet for 150 ms, so only forced evaluations run.
  t.send(B.hashes, 100);
  const midBurst = t.active.map((p) => p?.id);
  assert.ok(midBurst.length <= 1, 'at most one commit while the burst runs');
  t.clock.advance(1000);
  assert.deepEqual(
    t.active.map((p) => p?.id),
    ['p2'],
  );
});

await test('an animated key does not delay the commit', () => {
  const t = setup();
  for (let i = 0; i < 12; i++) {
    t.tracker.noteFrame(5, hashOf(`tick${i}`));
    t.clock.advance(50);
    if (i === 3) t.send(A.hashes.map((h, k) => (k === 5 ? null : h)));
  }
  t.clock.advance(150);
  assert.equal(t.active.at(-1)?.id, 'p1');
  assert.ok(t.last().suggestedIgnore.includes(5), 'the animated key is suggested for ignoring');
});

await test('a forced mid-burst result needs a second agreeing one', () => {
  const t = setup();
  // A non-animated key changes every 100 ms, so the settle timer never fires.
  const noisy = A.hashes.map((h, k) => (k === 0 ? null : h));
  t.send(noisy);
  for (let i = 0; i < 6; i++) {
    t.tracker.noteFrame(0, i % 2 === 0 ? A.hashes[0]! : hashOf(`x${i}`));
    t.clock.advance(120);
  }
  // First forced evaluation (600 ms) only records pending; the second commits.
  assert.deepEqual(
    t.active.map((p) => p?.id),
    ['p1'],
  );
});

await test('too few distinct images hold the layout', () => {
  const t = setup();
  t.send(A.hashes);
  t.clock.advance(1000);
  t.send(Array.from({ length: 15 }, () => hashOf('black')));
  t.clock.advance(1000);
  assert.equal(t.active.length, 1, 'no change on a blank vector');
  assert.equal(t.last().held, true);
  assert.equal(t.last().activePageId, 'p1');
});

await test('an unknown page falls back to the default layout', () => {
  const t = setup();
  t.send(A.hashes);
  t.clock.advance(1000);
  t.send(Array.from({ length: 15 }, (_, i) => hashOf(`C-${i}`)));
  t.clock.advance(1000);
  assert.deepEqual(
    t.active.map((p) => p?.id),
    ['p1', undefined],
  );
});

await test('re-sent identical frames arm no timer and push nothing', () => {
  const t = setup();
  t.send(A.hashes);
  t.clock.advance(200);
  const seen = t.observations.length;
  t.clock.advance(5000);
  t.send(A.hashes);
  assert.equal(t.clock.pending, 0);
  assert.equal(t.observations.length, seen);
});

await test('reset keeps the active page and clears the frames', () => {
  const t = setup();
  t.send(A.hashes);
  t.clock.advance(200);
  t.tracker.reset();
  assert.equal(t.last().held, true);
  assert.equal(t.last().activePageId, 'p1');
  assert.ok(t.last().hashes.every((h) => h === null));
  assert.equal(t.tracker.activePage()?.id, 'p1');
});

await test('reset drops an active page saved for another profile', () => {
  const t = setup();
  t.send(A.hashes);
  t.clock.advance(200);
  t.geo.profile = 'stream-deck-plus';
  t.tracker.reset();
  assert.equal(t.tracker.activePage(), undefined);
  assert.equal(t.last().activePageId, null);
  assert.equal(t.active.at(-1), undefined, 'the widgets repaint with the default layout');
  assert.equal(t.active.length, 2);
});

await test('the first frame of a burst publishes settling at once', () => {
  const t = setup();
  t.send(A.hashes);
  t.clock.advance(200);
  t.clock.advance(600); // past the animated-gap window of the first burst
  const seen = t.observations.length;
  t.tracker.noteFrame(0, B.hashes[0]!);
  assert.equal(t.observations.length, seen + 1);
  assert.equal(t.last().settling, true);
  assert.equal(t.last().activePageId, 'p1', 'verdict unchanged until the burst is quiet');
  t.tracker.noteFrame(1, B.hashes[1]!);
  assert.equal(t.observations.length, seen + 1, 'later frames of the burst push nothing');
});

await test('identical replays do not suggest ignoring static keys', () => {
  const t = setup();
  t.send(A.hashes);
  t.clock.advance(200);
  t.send(A.hashes);
  t.clock.advance(50);
  t.send(A.hashes);
  t.tracker.reload();
  assert.deepEqual(t.last().suggestedIgnore, []);
  assert.equal(t.clock.pending, 0);
});

await test('reload during a burst waits for settling before committing', () => {
  const t = setup();
  t.send(A.hashes);
  t.clock.advance(1000);
  t.active.length = 0;
  t.send(B.hashes.map((h, k) => (k < 4 ? h : null)));
  t.store.pages = [A, { ...B, minMatch: 0.5, ignore: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] }];
  t.tracker.reload();
  assert.equal(t.active.length, 0, 'half-updated hashes must not commit on reload');
  t.clock.advance(150);
  assert.equal(t.active.at(-1)?.id, 'p2');
});

await test('reload: a deleted active page reverts at once; a new matching page commits at once', () => {
  const t = setup();
  t.send(A.hashes);
  t.clock.advance(200);
  t.store.pages = [B];
  t.tracker.reload();
  assert.equal(t.active.at(-1), undefined);
  assert.equal(t.active.length, 2);
  t.store.pages = [A, B];
  t.tracker.reload();
  assert.equal(t.active.at(-1)?.id, 'p1');
  assert.equal(t.clock.pending, 0, 'no timer involved');
});

await test('frames for a key outside the grid are ignored', () => {
  const t = setup();
  t.tracker.noteFrame(15, hashOf('x'));
  t.tracker.noteFrame(-1, hashOf('x'));
  assert.equal(t.clock.pending, 0);
});

await test('stop: no callbacks once pending timers would have fired', () => {
  const t = setup();
  t.send(A.hashes);
  t.tracker.stop();
  t.clock.advance(2000);
  assert.equal(t.active.length, 0);
});

summaryExit();
