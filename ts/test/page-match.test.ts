import assert from 'tjs:assert';
import {
  isHeldVector,
  pickWinner,
  rankPages,
  requiredMatches,
  scorePage,
  suggestIgnore,
} from '../src/shared/page-match.js';
import { consideredKeys } from '../src/shared/page-config.js';
import { testAsync as test, summaryExit } from './helpers/harness.js';
import { hashOf, makePage, pageHashes } from './helpers/pages.js';

console.log('\npage-match');

const A = makePage('p1', 'A');
const B = makePage('p2', 'B');
const rank = (pages: ReturnType<typeof makePage>[], cur: (string | null)[]) =>
  rankPages(pages, cur, 'mk2', 15);
const ids = (pages: ReturnType<typeof makePage>[]): string[] =>
  rank(pages, A.hashes).map((s) => s.pageId);
const ignoreOf = (h: (string | null)[]): number[] => suggestIgnore(h, new Set());
const winnerId = (pages: ReturnType<typeof makePage>[], cur: (string | null)[]) =>
  pickWinner(rank(pages, cur), pages)?.pageId;

await test('consideredKeys drops null hashes and ignored keys', () => {
  const page = makePage('p1', 'A', { ignore: [2], hashes: [...pageHashes('A', 14), null] });
  assert.deepEqual(consideredKeys(page), [0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
});

await test('requiredMatches', () => {
  assert.equal(requiredMatches(15, 0.8), 12);
  assert.equal(requiredMatches(3, 0.8), 3);
  assert.equal(requiredMatches(1, 0.8), 1);
  assert.equal(requiredMatches(5, 0.6), 3);
  assert.equal(requiredMatches(10, 1), 10);
});

await test('exact page wins with nothing mismatched', () => {
  const score = scorePage(A, A.hashes);
  assert.deepEqual(score, { pageId: 'p1', matched: 15, considered: 15, mismatched: [] });
  assert.equal(winnerId([A, B], A.hashes), 'p1');
});

await test('one live key (clock) still matches and is reported', () => {
  const cur = [...A.hashes];
  cur[4] = hashOf('tick');
  const [score] = rank([A], cur);
  assert.deepEqual(score, { pageId: 'p1', matched: 14, considered: 15, mismatched: [4] });
  assert.equal(winnerId([A], cur), 'p1');
});

await test('an ignored live key no longer counts', () => {
  const page = makePage('p1', 'A', { ignore: [4] });
  const cur = [...A.hashes];
  cur[4] = hashOf('tick');
  assert.deepEqual(scorePage(page, cur), {
    pageId: 'p1',
    matched: 14,
    considered: 14,
    mismatched: [],
  });
});

await test('an unknown page matches nothing (default layout)', () => {
  assert.equal(winnerId([A], B.hashes), undefined);
});

await test('near-duplicates: exact page beats the one sharing 12 of 15 keys', () => {
  const A2 = makePage('p2', 'A2', {
    hashes: [...A.hashes.slice(0, 12), ...pageHashes('Z').slice(12)],
  });
  assert.equal(winnerId([A, A2], A2.hashes), 'p2');
  assert.equal(winnerId([A, A2], A.hashes), 'p1');
});

await test('tie on ratio: more considered keys first, then list order', () => {
  const small = makePage('p1', 'A', { ignore: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] });
  const full = makePage('p2', 'A');
  const twin = makePage('p3', 'A');
  assert.deepEqual(ids([small, full]), ['p2', 'p1']);
  assert.deepEqual(ids([twin, full]), ['p3', 'p2']);
});

await test('strict page fails on one mismatch, loose page passes', () => {
  const cur = [...A.hashes];
  cur[0] = hashOf('x');
  const strict = makePage('p1', 'A', { minMatch: 1 });
  const loose = makePage('p2', 'A', { minMatch: 0.6 });
  assert.equal(winnerId([strict], cur), undefined);
  assert.equal(winnerId([loose], cur), 'p2');
});

await test('stale pages (other profile or key count) are not ranked', () => {
  const other = makePage('p1', 'A', { profile: 'stream-deck-plus' });
  assert.deepEqual(rank([other], A.hashes), []);
  assert.deepEqual(rankPages([A], A.hashes.slice(0, 6), 'mk2', 6), []);
});

await test('sparse pages: ignoring blank keys keeps two pages apart', () => {
  const blank = hashOf('blank');
  const sparse = (tag: string): (string | null)[] =>
    Array.from({ length: 15 }, (_, i) => (i < 3 ? hashOf(`${tag}-${i}`) : blank));
  const X = makePage('p1', 'X', { hashes: sparse('X'), ignore: ignoreOf(sparse('X')) });
  const Y = makePage('p2', 'Y', { hashes: sparse('Y'), ignore: ignoreOf(sparse('Y')) });
  assert.deepEqual(
    rank([X, Y], sparse('Y')).map((s) => [s.pageId, s.matched]),
    [
      ['p2', 3],
      ['p1', 0],
    ],
  );
  assert.equal(winnerId([X, Y], sparse('Y')), 'p2');
});

await test('isHeldVector', () => {
  assert.equal(isHeldVector(Array.from({ length: 15 }, () => null)), true);
  assert.equal(isHeldVector(Array.from({ length: 15 }, () => hashOf('b'))), true);
  assert.equal(isHeldVector([hashOf('a'), hashOf('b'), null]), false);
});

await test('suggestIgnore: duplicates plus animated, sorted', () => {
  const dup = hashOf('blank');
  const cur = [hashOf('a'), dup, hashOf('b'), dup, hashOf('c')];
  assert.deepEqual(suggestIgnore(cur, new Set([4])), [1, 3, 4]);
});

await test('suggestIgnore: animated only when duplicates would leave nothing', () => {
  const dup = hashOf('blank');
  assert.deepEqual(suggestIgnore([dup, dup, dup], new Set([1])), [1]);
});

await test('a half-filled vector does not match', () => {
  const cur = A.hashes.map((h, i) => (i < 8 ? h : null));
  assert.equal(scorePage(A, cur).matched, 8);
  assert.equal(winnerId([A], cur), undefined);
});

summaryExit();
