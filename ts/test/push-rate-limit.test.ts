import assert from 'tjs:assert';
import { PushRateLimits, TokenBucket } from '../src/web/server/push-rate-limit.js';
import { testAsync as test, summary } from './helpers/harness.js';

console.log('\npush rate limits');

await test('bucket: 20 takes then wait, refills 10/s', () => {
  let t = 0;
  const b = new TokenBucket(20, 10, () => t);
  for (let i = 0; i < 20; i++) assert.equal(b.take(), 0);
  assert.equal(b.take(), 1);
  t = 100;
  assert.equal(b.take(), 0);
  assert.equal(b.take(), 1);
});

await test('per-token isolation and global cap', () => {
  const t = 0;
  const l = new PushRateLimits(() => t);
  for (let i = 0; i < 20; i++) assert.equal(l.takePush('a'), 0);
  assert.ok(l.takePush('a') > 0);
  assert.equal(l.takePush('b'), 0);
  // global bucket (50) drains across tokens
  const g = new PushRateLimits(() => t);
  let ok = 0;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 20; j++) if (g.takePush(`t${i}`) === 0) ok++;
  assert.equal(ok, 50);
});

await test('failed auth: blocked after 10, recovers after ~6s', () => {
  let t = 0;
  const l = new PushRateLimits(() => t);
  for (let i = 0; i < 9; i++) l.noteFailedAuth('peer-a');
  assert.equal(l.checkFailedAuth('peer-a'), 0);
  l.noteFailedAuth('peer-a');
  assert.ok(l.checkFailedAuth('peer-a') > 0);
  assert.equal(l.checkFailedAuth('peer-b'), 0);
  t = 7000;
  assert.equal(l.checkFailedAuth('peer-a'), 0);
});

await test('failed-auth map stays bounded', () => {
  const l = new PushRateLimits(() => 0);
  for (let i = 0; i < 600; i++) l.noteFailedAuth(`a${i}`);
  assert.ok((l as unknown as { failed: Map<string, unknown> }).failed.size <= 256);
});

summary();
