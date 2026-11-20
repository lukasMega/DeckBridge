/* eslint-disable sonarjs/no-hardcoded-ip -- fixture addresses, nothing is contacted */
import assert from 'tjs:assert';
import {
  lanPeer,
  parseRelayEvent,
  RateLimit,
  tokenMatches,
} from '../src/web/server/relay-script-guard.js';
import { test, summary } from './helpers/harness.js';

console.log('\nrelay script guard');

test('tokenMatches compares exactly and rejects null / other lengths', () => {
  assert.ok(tokenMatches('abc', 'abc'));
  for (const bad of [null, '', 'abd', 'abcd', 'ab']) assert.equal(tokenMatches(bad, 'abc'), false);
});

test('lanPeer accepts private ranges and unwraps ::ffff:', () => {
  for (const ok of [
    '10.0.0.5',
    '172.16.1.1',
    '172.31.9.9',
    '192.168.1.50',
    '100.64.0.1',
    '169.254.1.1',
    '127.0.0.1',
    '198.19.249.2',
    '::ffff:192.168.1.9',
  ]) {
    assert.ok(lanPeer(ok) !== null, ok);
  }
  assert.equal(lanPeer('::ffff:192.168.1.9'), '192.168.1.9');
});

test('lanPeer refuses public, malformed and IPv6 peers', () => {
  for (const bad of [
    '8.8.8.8',
    '172.32.0.1',
    '100.128.0.1',
    '192.169.0.1',
    '300.1.1.1',
    '::1',
    'fe80::1',
    '',
    'x',
  ]) {
    assert.equal(lanPeer(bad), null, bad);
  }
});

const GOOD = { t: 'tok', stage: 'running', platform: 'linux-arm64', version: '0.23.0' };

test('parseRelayEvent accepts a good body, with or without message', () => {
  assert.deepEqual(parseRelayEvent(JSON.stringify(GOOD)), GOOD);
  const f = { ...GOOD, stage: 'failed', message: 'Checksum mismatch.' };
  assert.deepEqual(parseRelayEvent(JSON.stringify(f)), f);
});

test('parseRelayEvent refuses bad json, stages, fields and messages', () => {
  const bad = [
    'nope',
    'null',
    '[]',
    JSON.stringify({ ...GOOD, stage: 'offline' }),
    JSON.stringify({ ...GOOD, stage: 'bogus' }),
    JSON.stringify({ ...GOOD, t: 1 }),
    JSON.stringify({ ...GOOD, platform: 'a b' }),
    JSON.stringify({ ...GOOD, version: '1.0; id' }),
    JSON.stringify({ ...GOOD, message: 'x'.repeat(201) }),
    JSON.stringify({ ...GOOD, message: 'a"b' }),
    JSON.stringify({ ...GOOD, message: 5 }),
  ];
  for (const b of bad) assert.equal(parseRelayEvent(b), null, b);
});

test('parseRelayEvent keeps a LAN selfIp and drops any other, never the event', () => {
  assert.equal(
    parseRelayEvent(JSON.stringify({ ...GOOD, selfIp: '192.168.139.155' }))?.selfIp,
    '192.168.139.155',
  );
  for (const selfIp of ['8.8.8.8', 'x', 5, '192.168.1.1"']) {
    assert.deepEqual(parseRelayEvent(JSON.stringify({ ...GOOD, selfIp })), GOOD, String(selfIp));
  }
});

test('RateLimit allows max per window and recovers', () => {
  const r = new RateLimit(2, 1000);
  assert.ok(r.allow(0));
  assert.ok(r.allow(10));
  assert.equal(r.allow(20), false);
  assert.ok(r.allow(1001));
});

summary();
