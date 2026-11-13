/* eslint-disable sonarjs/no-hardcoded-ip -- fixture addresses, nothing is contacted */
import assert from 'tjs:assert';
import {
  detectPlatform,
  isProbeableAddress,
  pairingCandidates,
  probeAddress,
  testAddress,
} from '../src/web/server/pairing-address.js';
import { testAsync as test, summary } from './helpers/harness.js';

console.log('\npairing address helper');

await test("only loopback and this computer's own IPv4s may be probed", () => {
  const own = ['192.168.2.212'];
  for (const ip of ['127.0.0.1', '127.0.0.2', '127.255.255.254', '192.168.2.212']) {
    assert.ok(isProbeableAddress(ip, own), ip);
  }
  for (const ip of [
    '8.8.8.8',
    '0.0.0.0',
    '10.1.2.3',
    '192.168.2.213',
    '127.0.0',
    '127.0.0.256',
    'localhost',
    '::1',
    '',
    42,
    null,
  ]) {
    assert.ok(!isProbeableAddress(ip, own), String(ip));
  }
});

await test('platform names map to the three supported OS tabs', () => {
  assert.equal(detectPlatform('macOS'), 'macos');
  assert.equal(detectPlatform('Windows'), 'windows');
  assert.equal(detectPlatform('Linux'), 'linux');
  assert.equal(detectPlatform('FreeBSD'), 'other');
  assert.equal(detectPlatform(''), 'other');
});

await test('candidates start with the loopback aliases', () => {
  const c = pairingCandidates();
  assert.deepEqual(
    c.slice(0, 3).map((x) => x.ip),
    ['127.0.0.2', '127.0.0.3', '127.0.0.4'],
  );
  assert.ok(c.every((x) => (x.kind === 'loopback') === x.ip.startsWith('127.')));
});

await test('a missing address fails at stage address with the how-to', async () => {
  const r = await testAddress(
    '127.0.0.2',
    () => Promise.reject(new Error('EADDRNOTAVAIL')),
    '0.0.0.0',
  );
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'address');
  assert.ok(r.error?.includes('127.0.0.2'));
});

await test('an existing address passes when CORA listens on every interface', async () => {
  const r = await testAddress('127.0.0.2', () => Promise.resolve(), '0.0.0.0');
  assert.deepEqual(r, { ok: true, stage: 'listen' });
});

await test('--bind 127.0.0.1 makes an alias unreachable: stage listen, names the flag', async () => {
  const r = await testAddress('127.0.0.2', () => Promise.resolve(), '127.0.0.1');
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'listen');
  assert.ok(r.error?.includes('--bind'));
  assert.ok((await testAddress('127.0.0.1', () => Promise.resolve(), '127.0.0.1')).ok);
});

await test('the real probe works on 127.0.0.1 and leaves no listener behind', async () => {
  await probeAddress('127.0.0.1');
  await probeAddress('127.0.0.1');
});

await test('the real probe rejects an address this computer does not own', async () => {
  let failed = false;
  try {
    await probeAddress('203.0.113.9'); // TEST-NET-3: never a local interface
  } catch {
    failed = true;
  }
  assert.ok(failed);
});

summary();
