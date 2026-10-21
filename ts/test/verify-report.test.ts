// Verify wizard report: results in the device-notes.json vocabulary, the report section in
// the bug-report export, and the prefilled GitHub issue link with its length fallback.
import assert from 'tjs:assert';
import {
  MAX_ISSUE_URL,
  issueUrl,
  verifyReport,
  type VerifyAnswers,
  type VerifyOutcome,
} from '../src/web/client/simple/verify-wizard/verify-report.js';
import { buildBugReport } from '../src/web/client/simple/bug-report-export.js';
import type { DeviceOverridesView } from '../src/web/client/ui-types.js';
import { test, summaryExit } from './helpers/harness.js';

const SAME: VerifyOutcome = { failed: false, imageChanged: false, sizeChanged: false };

/** A full run that saved: every step answered once. */
const SAVED_RUN: VerifyAnswers = {
  visible: ['all'],
  orient: ['0'],
  colours: ['rgb'],
  order: ['0'],
  size: ['fits'],
  confirm: ['yes'],
  real: ['yes'],
  buttons: ['yes'],
};

test('a run that changed nothing passes everywhere', () => {
  const { results, answers } = verifyReport(SAVED_RUN, SAME);
  assert.deepEqual(results, {
    image: 'pass',
    input: 'pass',
    colours: 'pass',
    size: 'pass',
    realImages: 'pass',
  });
  assert.equal(answers, SAVED_RUN, 'the answers go into the report as given');
});

test('a saved change is fixed; size and image are judged separately', () => {
  const { results } = verifyReport(
    { ...SAVED_RUN, orient: ['90m', 'yes'], size: ['cut', 'fits'] },
    { failed: false, imageChanged: true, sizeChanged: true },
  );
  assert.equal(results.image, 'fixed');
  assert.equal(results.size, 'fixed');
  const sizeOnly = verifyReport(SAVED_RUN, { ...SAME, sizeChanged: true }).results;
  assert.equal(sizeOnly.image, 'pass');
  assert.equal(sizeOnly.size, 'fixed');
});

test('the last pick decides, so a re-pick overrides an earlier answer', () => {
  const learned = verifyReport({ ...SAVED_RUN, buttons: ['no', 'fixed'] }, SAME).results;
  assert.equal(learned.input, 'fixed');
  const unfixed = verifyReport({ ...SAVED_RUN, buttons: ['no'] }, SAME).results;
  assert.equal(unfixed.input, 'fail');
});

test('detected problems that the wizard cannot fix are fail', () => {
  const r = verifyReport(
    { ...SAVED_RUN, colours: ['bgr'], real: ['cut'], size: ['cut', 'cut', 'fail'] },
    SAME,
  ).results;
  assert.equal(r.colours, 'fail');
  assert.equal(r.realImages, 'fail');
  assert.equal(r.size, 'fail');
  assert.equal(verifyReport({ ...SAVED_RUN, real: ['wrong'] }, SAME).results.realImages, 'fail');
});

test('steps not reached or skipped are unknown', () => {
  const r = verifyReport({ visible: ['all'], size: ['other'] }, SAME).results;
  assert.deepEqual(r, {
    image: 'unknown',
    input: 'unknown',
    colours: 'unknown',
    size: 'unknown',
    realImages: 'unknown',
  });
  assert.equal(verifyReport({ ...SAVED_RUN, buttons: ['skip'] }, SAME).results.input, 'unknown');
});

test('a blank ladder that ran out fails the image whatever was answered', () => {
  const r = verifyReport({ visible: ['none'], blank: ['no', 'no'] }, { ...SAME, failed: true });
  assert.equal(r.results.image, 'fail');
  assert.equal(r.results.size, 'unknown');
});

test('the bug-report export carries the verify section only when given', () => {
  const view = {
    modelId: 'ajazz-akp153',
    overrides: { image: { rotate: 90 } },
    effective: {},
  } as unknown as DeviceOverridesView;
  const verify = verifyReport(SAVED_RUN, SAME);
  const report = buildBugReport(view, '0.21.0', [], 'ajazz-akp153', verify);
  assert.equal(report.verify, verify);
  assert.deepEqual(report.overrides, { image: { rotate: 90 } });
  assert.ok(!('verify' in buildBugReport(view, '0.21.0', [], 'ajazz-akp153')));
});

const MODEL = { modelId: 'ajazz-akp153', modelName: 'Ajazz AKP153', appVersion: '0.21.0' };

test('the issue link prefills the template fields', () => {
  const report = JSON.stringify({ modelId: MODEL.modelId, a: 'x + y & z' }, null, 2);
  const { url, withReport } = issueUrl(MODEL, report);
  assert.ok(withReport);
  const parsed = new URL(url);
  assert.equal(
    parsed.origin + parsed.pathname,
    'https://github.com/lukasMega/DeckBridge/issues/new',
  );
  const q = parsed.searchParams;
  assert.equal(q.get('template'), 'device_verification.yml');
  assert.equal(q.get('title'), '[Device check]: Ajazz AKP153');
  assert.equal(q.get('model'), 'Ajazz AKP153 (ajazz-akp153)');
  assert.equal(q.get('version'), '0.21.0');
  assert.equal(q.get('report'), report, 'the report round-trips, + and & included');
});

test('a link over the limit leaves the report out for a paste', () => {
  const big = 'x'.repeat(MAX_ISSUE_URL);
  const { url, withReport } = issueUrl(MODEL, big);
  assert.equal(withReport, false);
  assert.ok(url.length <= MAX_ISSUE_URL);
  const q = new URL(url).searchParams;
  assert.equal(q.get('report'), null);
  assert.equal(q.get('model'), 'Ajazz AKP153 (ajazz-akp153)', 'the other fields stay');
  // Right at the limit still fits: the cap is inclusive.
  const base = issueUrl(MODEL, '').url.length;
  assert.ok(issueUrl(MODEL, 'y'.repeat(MAX_ISSUE_URL - base)).withReport);
  assert.equal(issueUrl(MODEL, 'y'.repeat(MAX_ISSUE_URL - base + 1)).withReport, false);
});

summaryExit();
