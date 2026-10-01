import assert from 'tjs:assert';
import {
  findPushToken,
  generatePushToken,
  hashPushToken,
  isPushTokenRecord,
  timingSafeEqualHex,
  type PushTokenRecord,
} from '../src/infra/push-tokens.js';
import { PersistedSettings } from '../src/infra/settings.js';
import { loadSettings } from '../src/infra/settings-store.js';
import { testAsync as test, summary } from './helpers/harness.js';

const ROOT = `${tjs.tmpDir}/push-tokens-test-${tjs.pid}`;

async function record(id: string, token: string): Promise<PushTokenRecord> {
  return {
    id,
    name: id,
    scopes: ['push'],
    hash: await hashPushToken(token),
    prefix: token.slice(4, 10),
    createdAt: new Date().toISOString(),
  };
}

console.log('\npush tokens');

await test('generatePushToken: dbp_ + 43 base64url chars, distinct', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const { token, prefix } = generatePushToken();
    assert.ok(/^dbp_[\w-]{43}$/.test(token), token);
    assert.equal(prefix, token.slice(4, 10));
    seen.add(token);
  }
  assert.equal(seen.size, 100);
});

await test('hashPushToken matches the SHA-256 test vector', async () => {
  assert.equal(
    await hashPushToken('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

await test('timingSafeEqualHex', () => {
  assert.ok(timingSafeEqualHex('abcd', 'abcd'));
  assert.ok(!timingSafeEqualHex('abcd', 'abce'));
  assert.ok(!timingSafeEqualHex('abcd', 'abc'));
});

await test('findPushToken finds among several, rejects wrong/empty', async () => {
  const recs = [
    await record('a', 'dbp_aaa'),
    await record('b', 'dbp_bbb'),
    await record('c', 'dbp_ccc'),
  ];
  assert.equal((await findPushToken(recs, 'dbp_bbb'))?.id, 'b');
  assert.equal(await findPushToken(recs, 'dbp_nope'), undefined);
  assert.equal(await findPushToken([], 'dbp_bbb'), undefined);
});

await test('isPushTokenRecord rejects malformed records', async () => {
  const ok = await record('a', 'dbp_aaa');
  assert.ok(isPushTokenRecord(ok));
  assert.ok(!isPushTokenRecord({ ...ok, hash: undefined }));
  assert.ok(!isPushTokenRecord({ ...ok, scopes: 'push' }));
  assert.ok(!isPushTokenRecord({ ...ok, scopes: ['admin'] }));
  assert.ok(!isPushTokenRecord({ ...ok, hash: 'zz' }));
  assert.ok(!isPushTokenRecord(null));
});

await test('settings: persist, reload (drops invalid), json() omits, import ignores', async () => {
  const dir = `${ROOT}/rt`;
  const s = new PersistedSettings(dir);
  const good = await record('a', 'dbp_aaa');
  s.setPushTokens([good]);
  await s.flush();
  const onDisk = await loadSettings(dir);
  assert.equal(onDisk.pushTokens?.length, 1);
  assert.ok(!JSON.stringify(onDisk).includes('dbp_aaa'), 'plaintext never stored');
  assert.ok(!('pushTokens' in JSON.parse(s.json())), 'export has no pushTokens');

  const s2 = new PersistedSettings(dir);
  await s2.load();
  assert.equal(s2.pushTokenRecords().length, 1);

  const bad = new PersistedSettings(`${ROOT}/bad`);
  bad.setPushTokens([good, { id: 'x' } as unknown as PushTokenRecord]);
  await bad.flush();
  const bad2 = new PersistedSettings(`${ROOT}/bad`);
  await bad2.load();
  assert.equal(bad2.pushTokenRecords().length, 1);
});

summary();
