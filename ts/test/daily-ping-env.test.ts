import assert from 'tjs:assert';
import { MIN_DWELL_MS, suppressReason } from '../src/daily-ping-env.js';
import type { EnvSnapshot, SuppressReason } from '../src/daily-ping-env.js';
import { test, summary } from './helpers/harness.js';

/** Long enough that only the env gates can be the reason. */
const DWELT = MIN_DWELL_MS + 1;

function reason(env: EnvSnapshot, uptimeMs = DWELT): SuppressReason {
  return suppressReason({ env, uptimeMs });
}

test('a plain long-running desktop session may ping', () => {
  assert.equal(reason({ HOME: '/Users/x', PATH: '/usr/bin' }), null);
});

test('kill switches suppress', () => {
  assert.equal(reason({ DECKBRIDGE_NO_DAILY_PING: '1' }), 'kill-switch');
  assert.equal(reason({ DO_NOT_TRACK: '1' }), 'kill-switch');
});

test('mock mode suppresses on any truthy value, with its own reason', () => {
  assert.equal(reason({ DECKBRIDGE_MOCK: '1' }), 'mock');
  assert.equal(reason({ DECKBRIDGE_MOCK: 'yes' }), 'mock');
});

test('an unset-looking mock value is not mock mode', () => {
  for (const v of ['', '0', 'false', ' ']) {
    assert.equal(reason({ DECKBRIDGE_MOCK: v }), null, `DECKBRIDGE_MOCK=${JSON.stringify(v)}`);
  }
});

test('every CI marker suppresses', () => {
  const vars = [
    'CI',
    'CONTINUOUS_INTEGRATION',
    'BUILD_NUMBER',
    'GITHUB_ACTIONS',
    'GITHUB_RUN_ID',
    'RUNNER_OS',
    'GITLAB_CI',
    'CIRCLECI',
    'TRAVIS',
    'APPVEYOR',
    'JENKINS_URL',
    'TEAMCITY_VERSION',
    'BUILDKITE',
    'TF_BUILD',
    'CODEBUILD_BUILD_ID',
    'DECKBRIDGE_E2E',
    'PLAYWRIGHT_BROWSERS_PATH',
  ];
  for (const name of vars) {
    assert.equal(reason({ [name]: 'true' }), 'ci', name);
  }
});

test('CI=false / CI= is not CI', () => {
  assert.equal(reason({ CI: 'false' }), null);
  assert.equal(reason({ CI: '' }), null);
  assert.equal(reason({ CI: '0' }), null);
});

test('the kill switch wins over mock, and mock over CI', () => {
  assert.equal(
    reason({ DECKBRIDGE_NO_DAILY_PING: '1', DECKBRIDGE_MOCK: '1', CI: '1' }),
    'kill-switch',
  );
  assert.equal(reason({ DECKBRIDGE_MOCK: '1', CI: '1' }), 'mock');
});

test('a short-lived process is suppressed by dwell (the sandbox case)', () => {
  assert.equal(reason({}, 0), 'dwell');
  assert.equal(reason({}, 2 * 60 * 1000), 'dwell');
  assert.equal(reason({}, MIN_DWELL_MS - 1), 'dwell');
  assert.equal(reason({}, MIN_DWELL_MS), null);
});

test('a nonsense uptime fails closed', () => {
  assert.equal(reason({}, NaN), 'dwell');
  assert.equal(reason({}, -1), 'dwell');
});

summary();
