import assert from 'tjs:assert';
import {
  beaconUrl,
  buildPayload,
  createTelemetry,
  encodePayload,
  normalizeOs,
  shouldPing,
  utcDay,
} from '../src/telemetry.js';
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

// buildPayload

console.log('\nbuildPayload');

const base = { version: '0.14.3', platform: 'macOS' };

await test('no device connected is a real answer, not an omission', () => {
  assert.deepEqual(buildPayload({ ...base, modelIds: [] }), {
    os: 'macos',
    v: '0.14.3',
    dv: 'none',
  });
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
  assert.deepEqual(decodePayload(encoded), { os: 'macos', v: '0.14.3', dv: 'mirabox-293s' });
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

// createTelemetry — no network in any of these

console.log('\ncreateTelemetry');

interface Sent {
  encoded: string;
  version: string;
}

interface Harness {
  sent: Sent[];
  days: string[];
  ping: () => Promise<void>;
}

function harness(
  opts: { enabled?: boolean; version?: string; lastPingDay?: string; modelIds?: string[] } = {},
): Harness {
  const sent: Sent[] = [];
  const days: string[] = [];
  let lastPingDay = opts.lastPingDay;
  const t = createTelemetry({
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
    now: () => new Date('2026-09-18T12:00:00Z'),
    platform: () => 'Linux',
  });
  return { sent, days, ping: () => t.ping() };
}

await test('sends the OS, version and device model, and records the day', async () => {
  const h = harness({ modelIds: ['mirabox-293s'] });
  await h.ping();
  assert.equal(h.sent.length, 1);
  assert.deepEqual(decodePayload(h.sent[0]!.encoded), {
    os: 'linux',
    v: '0.14.3',
    dv: 'mirabox-293s',
  });
  assert.deepEqual(h.days, ['2026-09-18']);
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
  const t = createTelemetry({
    currentVersion: '0.14.3',
    isEnabled: () => true,
    getLastPingDay: () => lastPingDay,
    setLastPingDay: (d) => {
      lastPingDay = d;
    },
    modelIds: () => [],
    send: () => Promise.reject(new Error('collector down')),
    now: () => new Date('2026-09-18T12:00:00Z'),
    platform: () => 'macOS',
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

// Summary

summary();
