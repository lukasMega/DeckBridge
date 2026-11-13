import assert from 'tjs:assert';
import statistics, { createStatistics } from '../src/extensions/statistics/server.js';
import type { ExtensionEvent, ExtensionInput } from '../src/extension/api.js';
import { test, testAsync, summary } from './helpers/harness.js';

const MIN = 60_000;
const T0 = 1_000 * MIN;
const byText = (a: string, b: string): number => a.localeCompare(b);

function attached(over: Partial<Extract<ExtensionEvent, { type: 'deckAttached' }>> = {}) {
  return {
    type: 'deckAttached' as const,
    at: T0,
    deviceKey: 'dk',
    modelName: 'Deck',
    source: 'usb' as const,
    hasEncoders: false,
    columns: 5,
    extraKeys: [],
    ...over,
  };
}

const input = (i: ExtensionInput, at = T0): ExtensionEvent => ({
  type: 'input',
  at,
  deviceKey: 'dk',
  input: i,
});

console.log('\nstatistics extension server');

test('a grid key is labelled R/C from the attach columns', () => {
  const s = createStatistics(T0, () => T0);
  s.onEvents([
    attached(),
    input({ kind: 'key', mk2: 7, state: 'down' }), // row 1, col 2 (0-based)
    input({ kind: 'key', mk2: 7, state: 'up' }),
    input({ kind: 'key', mk2: 0, state: 'down' }),
  ]);
  const d = s.snapshot().decks[0]!;
  assert.equal(d.keyPresses, 2);
  assert.deepEqual(d.keys.map((k) => k.label).toSorted(byText), ['R1 C1', 'R2 C3']);
});

test('a side key is labelled by its 1-based panel position', () => {
  const s = createStatistics(T0, () => T0);
  s.onEvents([
    attached({ extraKeys: [4, 10] }),
    input({ kind: 'extraKey', wireId: 10, state: 'down' }),
    input({ kind: 'extraKey', wireId: 99, state: 'down' }), // not on the panel
  ]);
  const labels = s
    .snapshot()
    .decks[0]!.keys.map((k) => k.label)
    .toSorted(byText);
  assert.deepEqual(labels, ['Extra 2', 'Extra 99']);
});

test('dials, touch and images reach the deck', () => {
  const s = createStatistics(T0, () => T0);
  s.onEvents([
    attached({ hasEncoders: true }),
    input({ kind: 'dialPress', index: 0, state: 'down' }),
    input({ kind: 'dialRotate', index: 0, delta: -3 }),
    input({ kind: 'touch' }),
    { type: 'imageProcessed', at: T0, deviceKey: 'dk', cached: true },
  ]);
  const d = s.snapshot().decks[0]!;
  assert.equal(d.hasEncoders, true);
  assert.equal(d.dialPresses, 1);
  assert.equal(d.dialDetents, 3);
  assert.equal(d.imagesProcessed, 1);
  assert.equal(d.cacheHits, 1);
});

test('activity buckets follow each event time, not the batch arrival', () => {
  const clock = { t: T0 };
  const s = createStatistics(T0, () => clock.t);
  clock.t = T0 + 2 * MIN; // the batch arrives late
  s.onEvents([
    attached(),
    input({ kind: 'key', mk2: 0, state: 'down' }, T0),
    input({ kind: 'key', mk2: 0, state: 'up' }, T0),
    input({ kind: 'key', mk2: 1, state: 'down' }, T0 + 2 * MIN),
  ]);
  const activity = s.snapshot().totals.activity;
  assert.equal(activity.at(-1), 1, 'this minute');
  assert.equal(activity.at(-3), 1, 'two minutes ago');
});

test('keys of a deck never attached are ignored; a second attach is a reconnect', () => {
  const s = createStatistics(T0, () => T0);
  s.onEvents([input({ kind: 'key', mk2: 0, state: 'down' })]);
  assert.equal(s.snapshot().decks.length, 0);
  s.onEvents([attached(), attached({ source: 'mock' })]);
  const d = s.snapshot().decks[0]!;
  assert.equal(d.reconnects, 1);
  assert.equal(d.source, 'mock');
});

await testAsync('the factory serves GET snapshot and 404s anything else', async () => {
  const server = statistics({ id: 'statistics', appStartedAt: 7, log: () => undefined });
  const ok = await server.handle!({ method: 'GET', path: 'snapshot', query: {} });
  assert.equal(ok.status, undefined);
  assert.equal((ok.body as { appStartedAt: number }).appStartedAt, 7);
  const other = await server.handle!({ method: 'POST', path: 'snapshot', query: {} });
  assert.equal(other.status, 404);
});

summary();
