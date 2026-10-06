import assert from 'tjs:assert';
import {
  isPageDefinition,
  layoutConfigFor,
  MAX_PAGES,
  nextPageId,
  PAGE_MIN_MATCH_DEFAULT,
  PAGE_NAME_MAX,
  sanitizePages,
  toPageSummary,
  withPageLayout,
} from '../src/shared/page-config.js';
import type { ExtraKeyConfig } from '../src/shared/types.js';
import { testAsync as test, summaryExit } from './helpers/harness.js';
import { makePage } from './helpers/pages.js';
import * as clientLimits from '../src/web/client/lib/page-limits.js';

console.log('\npage-config');

const base = (): ReturnType<typeof makePage> => makePage('p1', 'A');

await test('isPageDefinition accepts a valid page', () => {
  assert.ok(isPageDefinition(base()));
  assert.ok(
    isPageDefinition({
      ...base(),
      ignore: [1, 2],
      minMatch: 0.5,
      extraKeys: { '16': { widget: 'clock' } },
    }),
  );
});

await test('isPageDefinition rejects bad fields', () => {
  const bad: unknown[] = [
    null,
    { ...base(), id: 'x1' },
    { ...base(), name: '' },
    { ...base(), name: '  ' },
    { ...base(), name: 'x'.repeat(41) },
    { ...base(), profile: '' },
    { ...base(), hashes: base().hashes.slice(1) },
    { ...base(), hashes: [...base().hashes.slice(1), 'ABCDEF12'] },
    { ...base(), hashes: [...base().hashes.slice(1), 'abcdef1'] },
    { ...base(), ignore: [15] },
    { ...base(), ignore: [1, 1] },
    { ...base(), minMatch: 0.4 },
    { ...base(), minMatch: 1.1 },
    { ...base(), extraKeys: { '16': { widget: 'nope' } } },
  ];
  bad.forEach((v, i) => assert.equal(isPageDefinition(v), false, `case ${i}`));
});

await test('sanitizePages drops invalid entries and duplicate ids, caps the list', () => {
  const kept = sanitizePages([base(), { id: 'x' }, base(), makePage('p2', 'B')]);
  assert.deepEqual(
    kept?.map((p) => p.id),
    ['p1', 'p2'],
  );
  const many = Array.from({ length: 40 }, (_, i) => makePage(`p${i + 1}`, 'A'));
  assert.equal(sanitizePages(many)?.length, MAX_PAGES);
  assert.equal(sanitizePages('nope'), undefined);
});

await test('nextPageId', () => {
  assert.equal(nextPageId([]), 'p1');
  assert.equal(nextPageId([makePage('p1', 'A'), makePage('p7', 'B')]), 'p8');
});

await test('layoutConfigFor: a page with its own layout never falls back per key', () => {
  const def: Record<string, ExtraKeyConfig> = {
    '16': { widget: 'text', param: 'DEF' },
    '17': { widget: 'clock' },
  };
  const own = makePage('p1', 'A', { extraKeys: { '16': { widget: 'text', param: 'PAGE' } } });
  assert.equal(layoutConfigFor(undefined, def, 16)?.param, 'DEF');
  assert.equal(layoutConfigFor(base(), def, 16)?.param, 'DEF');
  assert.equal(layoutConfigFor(own, def, 16)?.param, 'PAGE');
  assert.equal(layoutConfigFor(own, def, 17), undefined);
});

await test('withPageLayout replaces or removes one page layout', () => {
  const pages = [base(), makePage('p2', 'B')];
  const set = withPageLayout(pages, 'p2', { '16': { widget: 'clock' } });
  assert.deepEqual(set[1]?.extraKeys, { '16': { widget: 'clock' } });
  assert.equal(set[0]?.extraKeys, undefined);
  assert.ok(!('extraKeys' in withPageLayout(set, 'p2', undefined)[1]!));
  assert.equal(pages[1]?.extraKeys, undefined, 'input untouched');
});

await test('toPageSummary carries no hashes, counts considered keys, flags stale', () => {
  const page = makePage('p1', 'A', { ignore: [0, 1] });
  const summary = toPageSummary(page, 'mk2', 15);
  assert.ok(!('hashes' in summary));
  assert.deepEqual(summary, {
    id: 'p1',
    name: 'Page A',
    keyCount: 15,
    ignore: [0, 1],
    minMatch: 0.8,
    considered: 13,
  });
  assert.equal(toPageSummary(page, 'stream-deck-plus', 15).stale, true);
  assert.equal(toPageSummary(page, 'mk2', 6).stale, true);
});

await test('the browser limits mirror the shared ones', () => {
  assert.equal(clientLimits.MAX_PAGES, MAX_PAGES);
  assert.equal(clientLimits.PAGE_NAME_MAX, PAGE_NAME_MAX);
  assert.ok(clientLimits.STRICTNESS.some((s) => s.value === PAGE_MIN_MATCH_DEFAULT));
});

await test('nearestStrictness snaps a free-form minMatch to a chip', () => {
  assert.equal(clientLimits.nearestStrictness(0.8), 0.8);
  assert.equal(clientLimits.nearestStrictness(0.72), 0.8);
  assert.equal(clientLimits.nearestStrictness(0.68), 0.6);
  assert.equal(clientLimits.nearestStrictness(0.95), 1);
  assert.equal(clientLimits.nearestStrictness(0.5), 0.6);
});

summaryExit();
