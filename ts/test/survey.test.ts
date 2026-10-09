import assert from 'tjs:assert';
import {
  SURVEY_VERSION,
  SURVEY_QUESTIONS,
  validateSurvey,
  prefillSurvey,
  SHORT_QUESTIONS,
  SURVEY_MIN_UPTIME_MS,
  SURVEY_NOTIFY_UPTIME_MS,
  shouldNotifySurvey,
  shouldNudgeSurvey,
  surveyContext,
  surveyPayload,
} from '../src/web/server/survey.js';
import { SurveyController } from '../src/web/server/survey-controller.js';
import { PersistedSettings } from '../src/infra/settings.js';
import { loadSettings, saveSettings, sanitizeSurveySettings } from '../src/infra/settings-store.js';
import type { Settings } from '../src/infra/settings-store.js';
import { surveyNotification } from '../src/main/survey-wiring.js';
import { makePage } from './helpers/pages.js';
import { testAsync as test, summary } from './helpers/harness.js';

const now = new Date('2026-10-09T12:00:00Z');
const paired = {
  deviceKey: 'usb:test',
  mdnsServiceName: 'Dock',
  macAddress: '00:11:22:33:44:55',
  dockSerial: 'A',
  childSerial: 'B',
  pairedAt: '2026-10-02T12:00:00Z',
};
const context = { v: '0.20.0', os: 'macos' as const, ov: 'macos-26', dv: 'mirabox-293s' };
const ROOT = `${tjs.tmpDir}/survey-test-${tjs.pid}`;

await test('bank contains ten questions and closed ids', () => {
  assert.equal(SURVEY_QUESTIONS.length, 10);
  for (const q of SURVEY_QUESTIONS) {
    assert.ok(/^[a-z0-9-]{1,32}$/.test(q.id));
    assert.ok(q.options.length <= 12);
    for (const o of q.options.flatMap((p) => [p, ...(p.options ?? [])]))
      assert.ok(/^[a-z0-9-]{1,32}$/.test(o.id));
  }
});
await test('drops unknown ids and wrong single/multi shapes', () => {
  assert.equal(
    validateSurvey({ rating: ['4', '5'], features: 'pages', bogus: 'yes', support: 'bogus' }, null),
    { a: {} },
  );
  assert.equal(
    validateSurvey({ rating: '4', found: 'ai-claude', 'use-for': ['development', 'invalid'] }, ''),
    { a: { rating: '4', found: 'ai-claude', 'use-for': ['development'] } },
  );
});
await test('discovery accepts bare channels and known details only', () => {
  for (const found of ['ai', 'ai-claude', 'search-google', 'github-topic', 'friend'])
    assert.equal(validateSurvey({ found }, '').a.found, found);
  for (const found of ['ai-', 'ai-unknown', 'search-google-extra'])
    assert.equal(validateSurvey({ found }, '').a, {});
});
await test('NPS accepts 0 through 10 only', () => {
  for (let i = 0; i <= 10; i++)
    assert.equal(validateSurvey({ nps: String(i) }, '').a.nps, String(i));
  for (const nps of ['11', '-1', '01', 5]) assert.equal(validateSurvey({ nps }, '').a, {});
});
await test('multi caps, deduplicates and counts a brand as one pick', () => {
  assert.equal(
    validateSurvey(
      { want: ['widgets', 'widgets', 'more-devices-ajazz', 'more-devices', 'multi-host', 'other'] },
      '',
    ).a.want,
    ['widgets', 'more-devices-ajazz', 'multi-host'],
  );
  assert.equal(validateSurvey({ pain: ['setup', 'disconnects', 'image-lag', 'docs'] }, '').a.pain, [
    'setup',
    'disconnects',
    'image-lag',
  ]);
  assert.equal(validateSurvey({ pain: ['setup', 'nothing'] }, '').a.pain, ['nothing']);
});
await test('comment trims, caps and omits empty text', () => {
  assert.equal(validateSurvey({}, '  hello  ').c, 'hello');
  assert.equal(validateSurvey({}, 'x'.repeat(300)).c?.length, 280);
  assert.equal(validateSurvey({}, '   '), { a: {} });
});
await test('other use detail trims, caps and requires Other selection', () => {
  const answers = { 'use-for': ['development', 'other'] };
  assert.equal(validateSurvey(answers, '', '  Teaching  ').useForOther, 'Teaching');
  assert.equal(validateSurvey(answers, 'General comment', 'x'.repeat(301)), {
    a: answers,
    c: 'General comment',
    useForOther: 'x'.repeat(300),
  });
  for (const detail of ['   ', null, 42, ['Teaching']])
    assert.equal(validateSurvey(answers, '', detail), { a: answers });
  for (const answer of [undefined, ['development'], 'other'])
    assert.equal(validateSurvey({ 'use-for': answer }, '', 'Teaching').useForOther, undefined);
});
await test('other request trims, caps and requires retained Other selection', () => {
  const answers = { want: ['widgets', 'other'] };
  assert.equal(
    validateSurvey(answers, '', undefined, '  MIDI support  ').wantOther,
    'MIDI support',
  );
  assert.equal(validateSurvey(answers, '', undefined, 'x'.repeat(101)), {
    a: answers,
    wantOther: 'x'.repeat(100),
  });
  for (const detail of ['   ', null, 42, ['MIDI support']])
    assert.equal(validateSurvey(answers, '', undefined, detail), { a: answers });
  for (const want of [
    undefined,
    ['widgets'],
    'other',
    ['widgets', 'home-assistant', 'linux-packages', 'other'],
  ])
    assert.equal(validateSurvey({ want }, '', undefined, 'MIDI support').wantOther, undefined);
});
await test('prefill maps settings without exposing private values', () => {
  const settings: Settings = {
    multiDeck: true,
    virtualDeck: { enabled: true, profile: 'mk2' },
    modelOverrides: { 'mirabox-293s': {} },
    accessTokens: [
      {
        id: 'private',
        prefix: 'private',
        hash: 'private',
        name: 'private',
        createdAt: '',
        scopes: ['push'],
      },
    ],
    devices: [
      {
        ...paired,
        extraKeys: { '16': { widget: 'plugin', param: '/secret/file.js' } },
        pages: [],
        touchStripMode: 'deckbridge-repaint',
        standby: { idleDim: true },
      },
    ],
  };
  assert.equal(prefillSurvey(settings).features, [
    'multi-deck',
    'side-keys',
    'touch-strip',
    'standby',
    'browser-deck',
    'push-api',
    'device-tuning',
    'auto-restart',
    'plugin-widgets',
  ]);
  assert.equal(
    prefillSurvey({
      devices: [
        { ...paired, standby: { idleDim: false, idleMinutes: 5 }, touchStripMode: 'elgato' },
      ],
      elgatoAutoRestart: false,
    }),
    {},
  );
});
await test('pages, saved page widgets and encoder evidence prefill features', () => {
  assert.equal(
    prefillSurvey({
      devices: [
        {
          ...paired,
          pages: [
            makePage('page', 'demo', { extraKeys: { '16': { widget: 'plugin', param: 'test' } } }),
          ],
          encoders: { connectToApp: false },
        },
      ],
      elgatoAutoRestart: false,
    }).features,
    ['side-keys', 'pages', 'touch-strip', 'plugin-widgets'],
  );
});
const up = SURVEY_MIN_UPTIME_MS;
await test('nudge gates uptime, any paired device, snooze, never and survey version', () => {
  assert.equal(shouldNudgeSurvey({}, now, up), false);
  assert.equal(
    shouldNudgeSurvey({ devices: [{ ...paired, pairedAt: 'invalid' }] }, now, up),
    false,
  );
  assert.equal(
    shouldNudgeSurvey({ devices: [{ ...paired, pairedAt: undefined }] }, now, up),
    false,
  );
  const base = { devices: [paired], a7s: false };
  assert.equal(shouldNudgeSurvey(base, now, up - 1), false);
  assert.equal(shouldNudgeSurvey(base, now, up), true);
  assert.equal(
    shouldNudgeSurvey({ devices: [{ ...paired, pairedAt: '2026-10-09T11:59:00Z' }] }, now, up),
    true,
  );
  for (const survey of [
    { never: true },
    { submittedSv: SURVEY_VERSION },
    { snoozedUntil: '2026-10-10T00:00:00Z' },
  ])
    assert.equal(shouldNudgeSurvey({ ...base, survey }, now, up), false);
  assert.equal(
    shouldNudgeSurvey(
      {
        ...base,
        survey: { submittedSv: SURVEY_VERSION - 1, snoozedUntil: '2026-10-08T00:00:00Z' },
      },
      now,
      up,
    ),
    true,
  );
});
const notifyUp = SURVEY_NOTIFY_UPTIME_MS;
await test('notify gates uptime, WebUI visit, notifiedSv and the nudge gate', () => {
  const base = { devices: [paired], a7s: false };
  assert.equal(notifyUp, 30 * 60 * 1000);
  assert.equal(shouldNotifySurvey(base, now, notifyUp - 1000, false), false);
  assert.equal(shouldNotifySurvey(base, now, notifyUp, false), true);
  assert.equal(shouldNotifySurvey(base, now, notifyUp, true), false);
  assert.equal(shouldNotifySurvey({}, now, notifyUp, false), false);
  assert.equal(
    shouldNotifySurvey({ devices: [{ ...paired, pairedAt: undefined }] }, now, notifyUp, false),
    false,
  );
  for (const survey of [
    { notifiedSv: SURVEY_VERSION },
    { never: true },
    { submittedSv: SURVEY_VERSION },
    { snoozedUntil: '2026-10-10T00:00:00Z' },
  ])
    assert.equal(shouldNotifySurvey({ ...base, survey }, now, notifyUp, false), false);
  assert.equal(
    shouldNotifySurvey(
      { ...base, survey: { notifiedSv: SURVEY_VERSION - 1 } },
      now,
      notifyUp,
      false,
    ),
    true,
  );
});
await test('notification text and link are fixed; notifiedSv is sanitized', () => {
  assert.equal(surveyNotification(3001), {
    title: 'DeckBridge',
    body: 'Enjoying DeckBridge? 3 quick taps help shape what comes next.',
    url: 'http://localhost:3001/?survey=1',
  });
  assert.equal(sanitizeSurveySettings({ notifiedSv: 2, submittedSv: 1 }), {
    notifiedSv: 2,
    submittedSv: 1,
  });
  for (const bad of [-1, 1.5, '2', null])
    assert.equal(sanitizeSurveySettings({ notifiedSv: bad }), {});
});
await test('takeNotification fires once, persists notifiedSv, and never in mock', async () => {
  const dir = `${ROOT}/notify`;
  await saveSettings({ devices: [paired], a7s: false }, dir);
  const settings = new PersistedSettings(dir);
  await settings.load();
  const survey = new SurveyController(settings);
  let mock = true;
  let uptime = notifyUp - 1;
  survey.configure({
    context: () => Promise.resolve(context),
    isMock: () => mock,
    now: () => now,
    uptimeMs: () => uptime,
    send: () => Promise.resolve({ sent: false, reason: 'mock' }),
  });
  assert.equal(survey.takeNotification(false), false);
  mock = false;
  assert.equal(survey.takeNotification(false), false);
  uptime = notifyUp;
  assert.equal(survey.takeNotification(true), false);
  assert.equal(settings.survey, {});
  assert.equal(survey.takeNotification(false), true);
  assert.equal(settings.survey?.notifiedSv, SURVEY_VERSION);
  assert.equal(survey.takeNotification(false), false);
  await settings.close();
  const reloaded = new PersistedSettings(dir);
  await reloaded.load();
  assert.equal(reloaded.survey?.notifiedSv, SURVEY_VERSION);
});
await test('context filters models and excludes locale/timezone', () => {
  assert.equal(
    surveyContext({
      version: '0.20.0',
      platform: 'macOS',
      osVersion: 'macos-26',
      modelIds: ['bad/path', 'mirabox-293s', 'mirabox-293s'],
      now,
      locale: 'sk-SK',
      timeZone: 'Europe/Bratislava',
    }),
    context,
  );
});
await test('settings sanitizer drops malformed or unknown survey fields', () => {
  assert.equal(
    sanitizeSurveySettings({
      never: 'yes',
      submittedSv: -1,
      submittedAt: 'invalid',
      answers: { rating: '5' },
    }),
    {},
  );
});

await test('mock bypasses sender and leaves saved state untouched', async () => {
  const settings = new PersistedSettings(`${ROOT}/mock`);
  const survey = new SurveyController(settings);
  let calls = 0;
  survey.configure({
    context: () => Promise.resolve(context),
    isMock: () => true,
    now: () => now,
    uptimeMs: () => 0,
    send: () => {
      calls++;
      return Promise.resolve({ sent: true });
    },
  });
  assert.equal(await survey.submit(surveyPayload(context, { rating: '4' }, 'hello')), {
    sent: false,
    reason: 'mock',
  });
  assert.equal(calls, 0);
  assert.equal(settings.survey, {});
});
await test('failed sends preserve nudge; success validates and persists only state', async () => {
  const dir = `${ROOT}/send`;
  await saveSettings({ devices: [paired], a7s: false }, dir);
  const settings = new PersistedSettings(dir);
  await settings.load();
  const survey = new SurveyController(settings);
  let sentBody = '';
  let success = false;
  survey.configure({
    context: () => Promise.resolve(context),
    isMock: () => false,
    now: () => now,
    uptimeMs: () => SURVEY_MIN_UPTIME_MS,
    send: (body) => {
      sentBody = body;
      return Promise.resolve(success ? { sent: true } : { sent: false, reason: 'offline' });
    },
  });
  const payload = surveyPayload(
    context,
    { rating: '4', 'use-for': ['other'], want: ['other'] },
    ' hello ',
    ' Teaching ',
    ' MIDI support ',
  );
  assert.equal((await survey.view()).nudge, true);
  assert.equal((await survey.submit(payload)).sent, false);
  assert.equal(settings.survey, {});
  success = true;
  assert.equal(await survey.submit({ ...payload, a: { ...payload.a, bogus: 'private' } }), {
    sent: true,
  });
  assert.equal(JSON.parse(sentBody), payload);
  await settings.flush();
  const saved = await loadSettings(dir);
  assert.equal(saved.survey, { submittedSv: SURVEY_VERSION, submittedAt: now.toISOString() });
  assert.equal((await survey.view()).nudge, false);
  assert.equal(settings.json().includes('hello'), false);
  assert.equal(settings.json().includes('Teaching'), false);
  assert.equal(settings.json().includes('MIDI support'), false);
  const reloaded = new PersistedSettings(dir);
  await reloaded.load();
  assert.equal(reloaded.survey, saved.survey);
});
await test('changed preview context is rejected before outbound send', async () => {
  const survey = new SurveyController(new PersistedSettings(`${ROOT}/changed`));
  survey.configure({
    context: () => Promise.resolve(context),
    isMock: () => false,
    uptimeMs: () => 0,
    send: () => {
      throw new Error('must not send');
    },
  });
  assert.equal(await survey.submit({ ...surveyPayload(context, {}, ''), dv: 'none' }), {
    sent: false,
    reason: 'rejected',
  });
});
await test('Other requires non-whitespace detail before outbound send', async () => {
  const settings = new PersistedSettings(`${ROOT}/required-details`);
  const survey = new SurveyController(settings);
  let calls = 0;
  survey.configure({
    context: () => Promise.resolve(context),
    isMock: () => false,
    uptimeMs: () => 0,
    send: () => {
      calls++;
      return Promise.resolve({ sent: true });
    },
  });
  for (const [id, field] of [
    ['use-for', 'useForOther'],
    ['want', 'wantOther'],
  ]) {
    for (const detail of [undefined, '', ' \n ', null, 42]) {
      assert.equal(
        await survey.submit({
          sv: SURVEY_VERSION,
          ...context,
          a: { [id!]: ['other'] },
          [field!]: detail,
        }),
        { sent: false, reason: 'rejected' },
      );
    }
  }
  assert.equal(calls, 0);
  assert.equal(settings.survey, {});
});
await test('view exposes short ids and gates the nudge on uptime', async () => {
  const dir = `${ROOT}/view`;
  await saveSettings({ devices: [paired], a7s: false }, dir);
  const settings = new PersistedSettings(dir);
  await settings.load();
  const survey = new SurveyController(settings);
  let uptime = up - 1;
  survey.configure({
    context: () => Promise.resolve(context),
    isMock: () => false,
    now: () => now,
    uptimeMs: () => uptime,
    send: () => Promise.resolve({ sent: true }),
  });
  assert.equal(SHORT_QUESTIONS, ['rating', 'nps', 'want']);
  const early = await survey.view();
  assert.equal(early.short, SHORT_QUESTIONS);
  assert.equal(early.nudge, false);
  uptime = up;
  assert.equal((await survey.view()).nudge, true);
});
await test('short form sends only its 3 answers and strips other from want', async () => {
  const settings = new PersistedSettings(`${ROOT}/short`);
  const survey = new SurveyController(settings);
  const bodies: string[] = [];
  survey.configure({
    context: () => Promise.resolve(context),
    isMock: () => false,
    now: () => now,
    uptimeMs: () => up,
    send: (body) => {
      bodies.push(body);
      return Promise.resolve({ sent: true });
    },
  });
  const base = { sv: SURVEY_VERSION, ...context, f: 'short' };
  const answers = { rating: '4', nps: '9', want: ['widgets', 'other'] };
  assert.equal(await survey.submit({ ...base, a: answers }), { sent: true });
  assert.equal(JSON.parse(bodies[0]!), {
    sv: SURVEY_VERSION,
    ...context,
    a: { rating: '4', nps: '9', want: ['widgets'] },
    f: 'short',
  });
  assert.equal(settings.survey?.submittedSv, SURVEY_VERSION);
  const rejected = { sent: false, reason: 'rejected' };
  for (const bad of [
    { ...base, a: { rating: '4', nps: '9' } },
    { ...base, a: { ...answers, want: ['other'] } },
    { ...base, a: { ...answers, nps: '11' } },
    { ...base, a: { ...answers, found: 'friend' } },
    { ...base, a: answers, c: 'hello' },
    { ...base, a: answers, wantOther: 'MIDI' },
    { ...base, a: answers, useForOther: 'x' },
    { ...base, f: 'full', a: answers },
    { ...base, f: 1, a: answers },
  ])
    assert.equal(await survey.submit(bad), rejected);
  assert.equal(bodies.length, 1);
});
await test('payload without f keeps the full-survey path', async () => {
  const survey = new SurveyController(new PersistedSettings(`${ROOT}/full`));
  const bodies: string[] = [];
  survey.configure({
    context: () => Promise.resolve(context),
    isMock: () => false,
    now: () => now,
    uptimeMs: () => up,
    send: (body) => {
      bodies.push(body);
      return Promise.resolve({ sent: true });
    },
  });
  assert.equal(
    await survey.submit({ ...surveyPayload(context, { rating: '4' }, 'hello'), found: 'x' }),
    { sent: true },
  );
  assert.equal(JSON.parse(bodies[0]!), {
    sv: SURVEY_VERSION,
    ...context,
    a: { rating: '4' },
    c: 'hello',
  });
});
await test('dismiss persists 30-day snooze and permanent opt-out', async () => {
  const settings = new PersistedSettings(`${ROOT}/dismiss`);
  const survey = new SurveyController(settings);
  survey.configure({
    context: () => Promise.resolve(context),
    isMock: () => true,
    now: () => now,
    uptimeMs: () => 0,
    send: () => Promise.resolve({ sent: false }),
  });
  survey.dismiss(false);
  assert.equal(settings.survey?.snoozedUntil, '2026-11-08T12:00:00.000Z');
  survey.dismiss(true);
  await settings.flush();
  assert.equal((await loadSettings(`${ROOT}/dismiss`)).survey?.never, true);
});
summary();
