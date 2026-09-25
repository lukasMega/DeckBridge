import assert from 'tjs:assert';
import {
  beaconUrl,
  buildPayload,
  createDailyPing,
  encodePayload,
  normalizeOs,
  normalizeLocale,
  parseOsVersion,
  shouldPing,
  tzOffset,
  utcDay,
} from '../src/daily-ping.js';
import type { SuppressReason } from '../src/daily-ping-env.js';
import { testAsync as test, summary } from './helpers/harness.js';

/** Mirrors the collector's decode: JSON.parse(decodeURIComponent(atob(v))). */
function decodePayload(encoded: string): Record<string, string> {
  const json = decodeURIComponent(Buffer.from(encoded, 'base64').toString('utf8'));
  return JSON.parse(json) as Record<string, string>;
}

// normalizeOs

console.log('\nnormalizeOs');

await test('maps the userAgentData platform names', () => {
  assert.equal(normalizeOs('macOS'), 'macos');
  assert.equal(normalizeOs('Windows'), 'windows');
  assert.equal(normalizeOs('Linux'), 'linux');
});

await test('accepts runtime-style names too', () => {
  assert.equal(normalizeOs('darwin'), 'macos');
  assert.equal(normalizeOs('win32'), 'windows');
});

await test('an absent or unknown platform is "unknown", never a guess', () => {
  assert.equal(normalizeOs(''), 'unknown');
  assert.equal(normalizeOs('Haiku'), 'unknown');
});

// utcDay

console.log('\nutcDay');

await test('is UTC, so client and collector agree on the day', () => {
  assert.equal(utcDay(new Date('2026-09-18T23:59:59Z')), '2026-09-18');
  assert.equal(utcDay(new Date('2026-09-19T00:00:00Z')), '2026-09-19');
});

// tzOffset

console.log('\ntzOffset');

/** `tzOffset` reads the host's own offset, so a real Date would make every
 *  assertion depend on the runner's TZ. Only the one method is used. */
function dateAtOffset(minutesBehindUtc: number): Date {
  return { getTimezoneOffset: () => minutesBehindUtc } as Date;
}

await test('formats the offset, not the IANA zone', () => {
  assert.equal(tzOffset(dateAtOffset(-120)), 'UTC+02:00');
  assert.equal(tzOffset(dateAtOffset(0)), 'UTC+00:00');
  assert.equal(tzOffset(dateAtOffset(300)), 'UTC-05:00');
});

await test('handles the half- and quarter-hour zones', () => {
  assert.equal(tzOffset(dateAtOffset(-330)), 'UTC+05:30'); // India
  assert.equal(tzOffset(dateAtOffset(-345)), 'UTC+05:45'); // Nepal
});

await test('a nonsense offset is "unknown", not a bogus bucket', () => {
  assert.equal(tzOffset(dateAtOffset(-5000)), 'unknown');
  assert.equal(tzOffset(dateAtOffset(Number.NaN)), 'unknown');
});

// parseOsVersion

console.log('\nparseOsVersion');

await test('macOS keeps the major only', () => {
  assert.equal(parseOsVersion('macos', '26.6.2\n'), 'macos-26');
  assert.equal(parseOsVersion('macos', '15'), 'macos-15');
});

const ver = (b: string): string => `Microsoft Windows [Version 10.0.${b}]`;

await test('Windows 11 is split from 10 by build number, not version', () => {
  assert.equal(parseOsVersion('windows', ver('26100.4652')), 'windows-11');
  assert.equal(parseOsVersion('windows', ver('22000.0')), 'windows-11');
  assert.equal(parseOsVersion('windows', ver('19045.3803')), 'windows-10');
});

await test('linux reads id + version from os-release', () => {
  assert.equal(parseOsVersion('linux', 'ID=ubuntu\nVERSION_ID="24.04"\n'), 'ubuntu-24.04');
});

await test('a rolling distro has no VERSION_ID — the id alone is the answer', () => {
  assert.equal(parseOsVersion('linux', 'ID=arch\nNAME="Arch Linux"\n'), 'arch');
});

await test('unparsable input never guesses', () => {
  assert.equal(parseOsVersion('macos', ''), 'unknown');
  assert.equal(parseOsVersion('windows', 'access is denied.'), 'unknown');
  assert.equal(parseOsVersion('linux', 'NAME="Something"\n'), 'unknown');
  assert.equal(parseOsVersion('unknown', '1.2.3'), 'unknown');
});

await test('locale keeps language and region while discarding OS formatting', () => {
  assert.equal(normalizeLocale('pl_PL.UTF-8'), 'pl-PL');
  assert.equal(normalizeLocale('en-UK'), 'en-UK');
  assert.equal(normalizeLocale('en_GB'), 'en-GB');
  assert.equal(normalizeLocale('zh-Hant-TW'), 'zh-TW');
  assert.equal(normalizeLocale('sr_RS@latin'), 'sr-RS');
  for (const raw of ['', 'C', 'POSIX', 'en', 'invalid locale']) {
    assert.equal(normalizeLocale(raw), 'unknown');
  }
});

// buildPayload

console.log('\nbuildPayload');

const base = {
  version: '0.14.3',
  platform: 'macOS',
  osVersion: 'macos-26',
  locale: 'pl_PL.UTF-8',
  now: dateAtOffset(-120),
};

await test('no device connected is a real answer, not an omission', () => {
  assert.deepEqual(buildPayload({ ...base, modelIds: [] }), {
    os: 'macos',
    ov: 'macos-26',
    v: '0.14.3',
    dv: 'none',
    tz: 'UTC+02:00',
    country: 'pl-PL',
  });
});

await test('an off-vocabulary os version is dropped, never forwarded raw', () => {
  assert.equal(buildPayload({ ...base, osVersion: '26.6.2', modelIds: [] }).ov, 'unknown');
  assert.equal(buildPayload({ ...base, osVersion: '', modelIds: [] }).ov, 'unknown');
});

await test('two docks of one model count once', () => {
  assert.equal(
    buildPayload({ ...base, modelIds: ['mirabox-293s', 'mirabox-293s'] }).dv,
    'mirabox-293s',
  );
});

await test('sorted, so the same hardware always yields the same value', () => {
  assert.equal(
    buildPayload({ ...base, modelIds: ['mirabox-k1pro', 'elgato-mk2'] }).dv,
    'elgato-mk2,mirabox-k1pro',
  );
});

await test('anything outside the model-id shape is dropped before it can become a KV key', () => {
  assert.equal(
    buildPayload({ ...base, modelIds: ['bad id, with commas', 'elgato-mk2'] }).dv,
    'elgato-mk2',
  );
});

await test('capped at MAX_DEVICE_IDS', () => {
  const modelIds = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'b1'];
  assert.equal(buildPayload({ ...base, modelIds }).dv.split(',').length, 8);
});

// encodePayload / beaconUrl

console.log('\nencodePayload / beaconUrl');

await test('round-trips through the collector decode', () => {
  const encoded = encodePayload(buildPayload({ ...base, modelIds: ['mirabox-293s'] }));
  assert.deepEqual(decodePayload(encoded), {
    os: 'macos',
    ov: 'macos-26',
    v: '0.14.3',
    dv: 'mirabox-293s',
    tz: 'UTC+02:00',
    country: 'pl-PL',
  });
});

await test('percent-encodes base64 — a raw + would decode back as a space', () => {
  assert.ok(beaconUrl('a+b/c==').includes('v=a%2Bb%2Fc%3D%3D'));
});

await test('carries the site id', () => {
  assert.ok(beaconUrl('x').includes('s=deckbridge-app'));
});

// shouldPing

console.log('\nshouldPing');

const gate = { enabled: true, version: '0.14.3', lastPingDay: undefined, today: '2026-09-18' };

await test('pings when enabled and not yet sent today', () => {
  assert.ok(shouldPing(gate));
  assert.ok(shouldPing({ ...gate, lastPingDay: '2026-09-17' }));
});

await test('opt-out wins', () => {
  assert.equal(shouldPing({ ...gate, enabled: false }), false);
});

await test('at most once per day', () => {
  assert.equal(shouldPing({ ...gate, lastPingDay: '2026-09-18' }), false);
});

await test('a dev build never pings — it would pollute the app_version dim', () => {
  assert.equal(shouldPing({ ...gate, version: '0.14.3-dev' }), false);
  assert.equal(shouldPing({ ...gate, version: 'unknown' }), false);
});

// createDailyPing — no network in any of these

console.log('\ncreateDailyPing');

interface Sent {
  encoded: string;
  version: string;
}

interface Harness {
  sent: Sent[];
  days: string[];
  ping: () => Promise<void>;
}

/** A real Date carrying a pinned offset, so `tz` doesn't depend on the runner's
 *  TZ. The own property shadows Date.prototype.getTimezoneOffset. */
function fixedDate(iso: string, offsetMinutes: number): Date {
  const d = new Date(iso);
  Object.defineProperty(d, 'getTimezoneOffset', { value: () => offsetMinutes });
  return d;
}

function harness(
  opts: {
    enabled?: boolean;
    version?: string;
    lastPingDay?: string;
    modelIds?: string[];
    suppress?: SuppressReason;
    readLocale?: string;
    browserLocale?: string;
  } = {},
): Harness {
  const sent: Sent[] = [];
  const days: string[] = [];
  let lastPingDay = opts.lastPingDay;
  const t = createDailyPing({
    currentVersion: opts.version ?? '0.14.3',
    isEnabled: () => opts.enabled ?? true,
    getLastPingDay: () => lastPingDay,
    setLastPingDay: (d) => {
      lastPingDay = d;
      days.push(d);
    },
    modelIds: () => opts.modelIds ?? [],
    send: (encoded, version) => {
      sent.push({ encoded, version });
      return Promise.resolve();
    },
    now: () => fixedDate('2026-09-18T12:00:00Z', -120),
    platform: () => 'Linux',
    readOsVersion: () => Promise.resolve('ID=ubuntu\nVERSION_ID="24.04"\n'),
    readLocale: () => Promise.resolve(opts.readLocale ?? 'pl_PL.UTF-8'),
    browserLocale: () => opts.browserLocale,
    suppress: () => opts.suppress ?? null,
  });
  return { sent, days, ping: () => t.ping() };
}

await test('sends the OS, version and device model, and records the day', async () => {
  const h = harness({ modelIds: ['mirabox-293s'] });
  await h.ping();
  assert.equal(h.sent.length, 1);
  assert.deepEqual(decodePayload(h.sent[0]!.encoded), {
    os: 'linux',
    ov: 'ubuntu-24.04',
    v: '0.14.3',
    dv: 'mirabox-293s',
    tz: 'UTC+02:00',
    country: 'pl-PL',
  });
  assert.deepEqual(h.days, ['2026-09-18']);
});

await test('a thrown OS-version probe degrades the dim, it does not lose the ping', async () => {
  const sent: Sent[] = [];
  const t = createDailyPing({
    currentVersion: '0.14.3',
    isEnabled: () => true,
    getLastPingDay: () => undefined,
    setLastPingDay: () => {},
    modelIds: () => [],
    send: (encoded, version) => {
      sent.push({ encoded, version });
      return Promise.resolve();
    },
    now: () => fixedDate('2026-09-18T12:00:00Z', 0),
    platform: () => 'Windows',
    readOsVersion: () => Promise.reject(new Error('spawn failed')),
    readLocale: () => Promise.resolve(''),
    suppress: () => null,
  });
  await t.ping();
  assert.equal(sent.length, 1);
  assert.equal(decodePayload(sent[0]!.encoded).ov, 'unknown');
});

await test('an unreadable OS locale falls back to the browser-reported one', async () => {
  const h = harness({ readLocale: '', browserLocale: 'en-GB' });
  await h.ping();
  assert.equal(decodePayload(h.sent[0]!.encoded).country, 'en-GB');
});

await test('a working OS locale wins over the browser fallback', async () => {
  const h = harness({ readLocale: 'pl_PL.UTF-8', browserLocale: 'en-GB' });
  await h.ping();
  assert.equal(decodePayload(h.sent[0]!.encoded).country, 'pl-PL');
});

await test('no browser ever connected leaves it unknown, same as before', async () => {
  const h = harness({ readLocale: '' });
  await h.ping();
  assert.equal(decodePayload(h.sent[0]!.encoded).country, 'unknown');
});

await test('a second call the same day is a no-op', async () => {
  const h = harness();
  await h.ping();
  await h.ping();
  assert.equal(h.sent.length, 1);
});

await test('disabled never reaches send, and never writes settings', async () => {
  const h = harness({ enabled: false });
  await h.ping();
  assert.equal(h.sent.length, 0);
  assert.equal(h.days.length, 0);
});

await test('a dev build never reaches send', async () => {
  const h = harness({ version: '0.0.0-local' });
  await h.ping();
  assert.equal(h.sent.length, 0);
});

await test('a new day pings again', async () => {
  const h = harness({ lastPingDay: '2026-09-17' });
  await h.ping();
  assert.equal(h.sent.length, 1);
});

await test('the day is marked before the send, so a dead collector is not retried per tick', async () => {
  let lastPingDay: string | undefined;
  const t = createDailyPing({
    currentVersion: '0.14.3',
    isEnabled: () => true,
    getLastPingDay: () => lastPingDay,
    setLastPingDay: (d) => {
      lastPingDay = d;
    },
    modelIds: () => [],
    send: () => Promise.reject(new Error('collector down')),
    now: () => fixedDate('2026-09-18T12:00:00Z', -120),
    platform: () => 'macOS',
    readOsVersion: () => Promise.resolve('26.6.2\n'),
    readLocale: () => Promise.resolve(''),
    suppress: () => null,
  });
  let threw = false;
  try {
    await t.ping();
  } catch {
    threw = true;
  }
  assert.ok(threw, 'the rejection propagates to the caller, which logs it at debug');
  assert.equal(lastPingDay, '2026-09-18');
});

await test('a suppressed environment never sends, and never writes settings', async () => {
  for (const reason of ['kill-switch', 'mock', 'ci', 'dwell'] as const) {
    const h = harness({ suppress: reason });
    await h.ping();
    assert.equal(h.sent.length, 0, reason);
    // `a7sDay` untouched is the point: a CI job or a sandbox detonation must not
    // consume the machine's ping for that day.
    assert.equal(h.days.length, 0, reason);
  }
});

await test('suppression is checked before the day gate, so the day survives it', async () => {
  const blocked = harness({ suppress: 'dwell' });
  await blocked.ping();
  const allowed = harness();
  await allowed.ping();
  assert.equal(allowed.sent.length, 1);
});

// Summary

summary();
