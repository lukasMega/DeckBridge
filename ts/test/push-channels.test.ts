import assert from 'tjs:assert';
import { PushChannels } from '../src/shared/push-channels.js';
import { testAsync as test, summary } from './helpers/harness.js';

const input = (text: string, ttlS = 10): { text: string; ttlS: number } => ({ text, ttlS });

console.log('\nPushChannels');

await test('live until expiresAt, then expired; ttl 0 never expires', () => {
  const s = new PushChannels();
  s.set('a', input('x', 5), 1000);
  assert.equal(s.view('a', 5999).state, 'live');
  assert.equal(s.view('a', 6000).state, 'expired');
  s.set('b', input('y', 0), 1000);
  assert.equal(s.view('b', 1e12).state, 'live');
  assert.equal((s.view('b', 0) as { value: { expiresAt: null } }).value.expiresAt, null);
});

await test('clear returns to waiting; unknown clear is false', () => {
  const s = new PushChannels();
  s.set('a', input('x'), 0);
  assert.ok(s.clear('a'));
  assert.equal(s.view('a', 0).state, 'waiting');
  assert.ok(!s.clear('a'));
});

await test('set replaces and refreshes expiry', () => {
  const s = new PushChannels();
  s.set('a', input('x', 5), 0);
  s.set('a', input('y', 5), 4000);
  const v = s.view('a', 8000);
  assert.equal(v.state, 'live');
  assert.equal((v as { value: { text: string } }).value.text, 'y');
});

await test('onChange fires for set, clear and evict; unsubscribe works', () => {
  const s = new PushChannels(1);
  const seen: string[] = [];
  const off = s.onChange((c) => seen.push(c));
  s.set('a', input('x', 1), 0);
  s.set('b', input('y', 1), 5000); // evicts expired a
  s.clear('b');
  assert.deepEqual(seen, ['a', 'a', 'b', 'b']);
  off();
  s.set('c', input('z'), 0);
  assert.equal(seen.length, 4);
});

await test('capacity: full without expired, evicts expired, existing channel ok', () => {
  const s = new PushChannels(2);
  s.set('a', input('x', 100), 0);
  s.set('b', input('y', 1), 0);
  assert.equal(s.set('c', input('z'), 500), 'full');
  assert.notEqual(s.set('a', input('x2', 100), 500), 'full');
  assert.notEqual(s.set('c', input('z'), 5000), 'full');
  assert.deepEqual(
    s.list().map((e) => e.channel),
    ['a', 'c'],
  );
});

await test('list is sorted', () => {
  const s = new PushChannels();
  for (const c of ['z', 'a', 'm']) s.set(c, input('x'), 0);
  assert.deepEqual(
    s.list().map((e) => e.channel),
    ['a', 'm', 'z'],
  );
});

summary();
