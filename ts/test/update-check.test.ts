import assert from 'tjs:assert';
import {
  parseSemver,
  isNewer,
  parseLatestRelease,
  createUpdateChecker,
  UpdateCheckError,
  RATE_LIMIT_MS,
} from '../src/update-check.js';
import type { UpdateState, UpdateCheckerDeps } from '../src/update-check.js';
import { testAsync as test, summary } from './helpers/harness.js';

// parseSemver / isNewer

console.log('\nparseSemver / isNewer');

await test('parseSemver parses a plain major.minor.patch', () => {
  assert.deepEqual(parseSemver('1.2.3'), [1, 2, 3]);
});

await test('parseSemver rejects a v-prefixed or malformed string', () => {
  assert.equal(parseSemver('v1.2.3'), null);
  assert.equal(parseSemver('1.2'), null);
  assert.equal(parseSemver('garbage'), null);
});

await test('isNewer: equal versions are not newer', () => {
  assert.equal(isNewer('1.2.3', '1.2.3'), false);
});

await test('isNewer: patch/minor/major bumps are newer', () => {
  assert.ok(isNewer('1.2.4', '1.2.3'));
  assert.ok(isNewer('1.3.0', '1.2.3'));
  assert.ok(isNewer('2.0.0', '1.2.3'));
});

await test('isNewer: an older version is not newer', () => {
  assert.equal(isNewer('1.2.3', '1.2.4'), false);
});

await test('isNewer: unparsable input never nags (false, not throw)', () => {
  assert.equal(isNewer('not-a-version', '1.2.3'), false);
  assert.equal(isNewer('1.2.3', 'not-a-version'), false);
});

// parseLatestRelease

console.log('\nparseLatestRelease');

await test('parses a real-shaped GitHub release payload', () => {
  const json = JSON.stringify({
    tag_name: 'deckbridge-v0.15.0',
    html_url: 'https://github.com/lukasMega/DeckBridge/releases/tag/deckbridge-v0.15.0',
    draft: false,
    prerelease: false,
  });
  assert.deepEqual(parseLatestRelease(json), {
    version: '0.15.0',
    url: 'https://github.com/lukasMega/DeckBridge/releases/tag/deckbridge-v0.15.0',
  });
});

await test('strips a bare v prefix too', () => {
  const json = JSON.stringify({ tag_name: 'v0.15.0', html_url: 'https://example.com/x' });
  assert.equal(parseLatestRelease(json)?.version, '0.15.0');
});

await test('drops a draft release', () => {
  const json = JSON.stringify({ tag_name: 'deckbridge-v0.15.0', html_url: 'x', draft: true });
  assert.equal(parseLatestRelease(json), null);
});

await test('drops a prerelease', () => {
  const json = JSON.stringify({ tag_name: 'deckbridge-v0.15.0', html_url: 'x', prerelease: true });
  assert.equal(parseLatestRelease(json), null);
});

await test('missing tag_name is rejected', () => {
  assert.equal(parseLatestRelease(JSON.stringify({ html_url: 'x' })), null);
});

await test('truncated/invalid JSON is rejected, not thrown', () => {
  assert.equal(parseLatestRelease('{"tag_name": "deckbridge-v0.1'), null);
});

// createUpdateChecker

console.log('\ncreateUpdateChecker');

function makeDeps(overrides: Partial<UpdateCheckerDeps> = {}): {
  deps: UpdateCheckerDeps;
  calls: number;
} {
  let state: UpdateState | undefined;
  let calls = 0;
  const deps: UpdateCheckerDeps = {
    currentVersion: '0.14.1',
    isEnabled: () => true,
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    fetchRelease: () => {
      calls++;
      return Promise.resolve(
        JSON.stringify({ tag_name: 'deckbridge-v0.15.0', html_url: 'https://example.com/rel' }),
      );
    },
    now: () => 1_000_000,
    ...overrides,
  };
  return { deps, calls };
}

await test('a fresh check populates state and reports updateAvailable', async () => {
  const { deps } = makeDeps();
  const checker = createUpdateChecker(deps);
  const info = await checker.check(true);
  assert.equal(info.latest, '0.15.0');
  assert.ok(info.updateAvailable);
  assert.equal(info.error, undefined);
});

await test('a warm cache (< 20h) serves cached state without calling fetchRelease', async () => {
  let fetchCalls = 0;
  let now = 0;
  const { deps } = makeDeps({
    fetchRelease: () => {
      fetchCalls++;
      return Promise.resolve(
        JSON.stringify({ tag_name: 'deckbridge-v0.15.0', html_url: 'https://example.com/rel' }),
      );
    },
    now: () => now,
  });
  const checker = createUpdateChecker(deps);
  await checker.check(true);
  assert.equal(fetchCalls, 1);
  now += RATE_LIMIT_MS - 1000;
  await checker.check(false);
  assert.equal(fetchCalls, 1, 'still warm — no second fetch');
});

await test('force bypasses the rate limit', async () => {
  let fetchCalls = 0;
  let now = 0;
  const { deps } = makeDeps({
    fetchRelease: () => {
      fetchCalls++;
      return Promise.resolve(
        JSON.stringify({ tag_name: 'deckbridge-v0.15.0', html_url: 'https://example.com/rel' }),
      );
    },
    now: () => now,
  });
  const checker = createUpdateChecker(deps);
  await checker.check(true);
  now += 1000;
  await checker.check(true);
  assert.equal(fetchCalls, 2);
});

await test('dismissed version stays in the DTO; updateAvailable is unaffected', async () => {
  const { deps } = makeDeps();
  const checker = createUpdateChecker(deps);
  await checker.check(true);
  checker.dismiss('0.15.0');
  const info = checker.toInfo();
  assert.equal(info.dismissedVersion, '0.15.0');
  assert.ok(info.updateAvailable, 'dismissal hides the badge client-side, not this flag');
});

await test('fetch failure reports error:network and preserves the prior cache', async () => {
  const { deps } = makeDeps();
  const checker = createUpdateChecker(deps);
  await checker.check(true); // seed a good cache

  let now = 0;
  const failing = createUpdateChecker({
    ...deps,
    fetchRelease: () => Promise.reject(new UpdateCheckError('network')),
    now: () => (now += RATE_LIMIT_MS + 1),
  });
  const info = await failing.check(true);
  assert.equal(info.error, 'network');
  assert.equal(info.latest, '0.15.0', 'cache preserved across a failed check');
});

await test('disabled (isEnabled: false) never calls fetchRelease', async () => {
  const { deps } = makeDeps({ isEnabled: () => false });
  let called = false;
  const checker = createUpdateChecker({
    ...deps,
    fetchRelease: () => {
      called = true;
      return Promise.resolve('{}');
    },
  });
  const info = await checker.check(true);
  assert.equal(called, false);
  assert.equal(info.enabled, false);
  assert.equal(info.updateAvailable, false);
});

await test('a malformed release body reports error:parse and still updates lastCheckedAt', async () => {
  const { deps } = makeDeps({ fetchRelease: () => Promise.resolve('not json') });
  const checker = createUpdateChecker(deps);
  const info = await checker.check(true);
  assert.equal(info.error, 'parse');
});

// Summary

summary();
