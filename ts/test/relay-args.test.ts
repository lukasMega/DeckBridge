/* eslint-disable sonarjs/no-hardcoded-ip -- fixture addresses, nothing is contacted */
import assert from 'tjs:assert';
import { parseRelayArgs } from '../src/main/relay/run.js';
import type { RelayArgs } from '../src/main/relay/run.js';
import { test, summary } from './helpers/harness.js';

function ok(rest: string[]): RelayArgs {
  const r = parseRelayArgs(rest);
  assert.ok(typeof r === 'object' && !('error' in r), `expected args, got ${JSON.stringify(r)}`);
  return r as RelayArgs;
}

function err(rest: string[]): string {
  const r = parseRelayArgs(rest);
  assert.ok(typeof r === 'object' && 'error' in r, `expected error, got ${JSON.stringify(r)}`);
  return (r as { error: string }).error;
}

console.log('relay args');

test('defaults', () => {
  assert.deepEqual(ok(['--target', '10.0.0.5']), {
    target: '10.0.0.5',
    targetPort: 5343,
    listenHost: '0.0.0.0',
    name: 'DeckBridge Relay',
    advertise: true,
    holdSeconds: 60,
  });
});

test('every flag', () => {
  const a = ok([
    '--target',
    'mac.local',
    '--target-port',
    '15343',
    '--listen-host',
    '127.0.0.1',
    '--name',
    'My Relay',
    '--no-advertise',
    '--hold-seconds',
    '90',
    '--log-level',
    'debug',
  ]);
  assert.deepEqual(a, {
    target: 'mac.local',
    targetPort: 15343,
    listenHost: '127.0.0.1',
    name: 'My Relay',
    advertise: false,
    holdSeconds: 90,
    logLevel: 'debug',
  });
});

test('help anywhere', () => {
  assert.equal(parseRelayArgs(['-h']), 'help');
  assert.equal(parseRelayArgs(['--target', 'x', '--help']), 'help');
});

test('missing --target', () => {
  assert.ok(err([]).includes('--target'));
  assert.ok(err(['--no-advertise']).includes('--target'));
});

test('unknown flag and stray positional', () => {
  assert.ok(err(['--target', 'x', '--bogus']).includes('--bogus'));
  assert.ok(err(['--target', 'x', 'extra']).includes('extra'));
});

test('missing value', () => {
  assert.ok(err(['--target']).includes('requires a value'));
  assert.ok(err(['--target', 'x', '--name']).includes('requires a value'));
});

test('duplicates', () => {
  assert.ok(err(['--target', 'a', '--target', 'b']).includes('duplicate'));
  assert.ok(err(['--target', 'a', '--no-advertise', '--no-advertise']).includes('duplicate'));
});

test('bad --log-level', () => {
  assert.ok(err(['--target', 'x', '--log-level', 'loud']).includes('--log-level'));
});

test('--name length 1-63', () => {
  assert.ok(err(['--target', 'x', '--name', '']).includes('--name'));
  assert.ok(err(['--target', 'x', '--name', 'a'.repeat(64)]).includes('--name'));
  assert.equal(ok(['--target', 'x', '--name', 'a'.repeat(63)]).name.length, 63);
  assert.equal(ok(['--target', 'x', '--name', 'a']).name, 'a');
});

test('--target-port range', () => {
  for (const bad of ['0', '65535', '-1', 'abc', '1.5', '']) {
    assert.ok(err(['--target', 'x', '--target-port', bad]).includes('--target-port'), bad);
  }
  assert.equal(ok(['--target', 'x', '--target-port', '65534']).targetPort, 65534);
  assert.equal(ok(['--target', 'x', '--target-port', '1']).targetPort, 1);
});

function hold(v: string): number {
  return ok(['--target', 'x', '--hold-seconds', v]).holdSeconds;
}

test('--hold-seconds range', () => {
  assert.equal(hold('0'), 0);
  assert.equal(hold('3600'), 3600);
  for (const bad of ['3601', '-1', 'abc', '1.5', '']) {
    const e = err(['--target', 'x', '--hold-seconds', bad]);
    assert.equal(e, '--hold-seconds must be an integer from 0 to 3600', bad);
  }
  assert.ok(
    err(['--target', 'x', '--hold-seconds', '5', '--hold-seconds', '6']).includes('duplicate'),
  );
});

summary();
