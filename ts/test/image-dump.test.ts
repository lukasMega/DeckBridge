import assert from 'tjs:assert';
import { DumpDir, DumpQueue, MAX_PENDING_DUMPS } from '../src/transform/image-dump.js';
import { testAsync, summary } from './helpers/harness.js';

const tmp = `${tjs.env['TMPDIR'] ?? '/tmp'}/deckbridge-dump-test-${Date.now()}`;

async function names(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const e of await tjs.readDir(dir)) out.push(e.name);
  return out.toSorted((a, b) => a.localeCompare(b));
}

await testAsync('ring evicts oldest only after writes, keeps newest N', async () => {
  const q = new DumpQueue();
  const d = new DumpDir(`${tmp}/a`, 3, q, 'w1');
  for (let i = 0; i < 8; i++) d.write(`f${i}`, new Uint8Array([i]));
  await q.drain();
  assert.deepEqual(await names(`${tmp}/a`), ['w1-f5', 'w1-f6', 'w1-f7']);
});

await testAsync('two workers sharing a dir do not collide', async () => {
  const q = new DumpQueue();
  const a = new DumpDir(`${tmp}/b`, 10, q, 'wa');
  const b = new DumpDir(`${tmp}/b`, 10, q, 'wb');
  a.write('0', new Uint8Array([1]));
  b.write('0', new Uint8Array([2]));
  await q.drain();
  assert.deepEqual(await names(`${tmp}/b`), ['wa-0', 'wb-0']);
});

await testAsync('pending count is bounded and drops new dumps', async () => {
  const q = new DumpQueue();
  let accepted = 0;
  for (let i = 0; i < MAX_PENDING_DUMPS + 10; i++) {
    if (q.enqueue(() => Promise.resolve())) accepted++;
  }
  assert.equal(accepted, MAX_PENDING_DUMPS);
  await q.drain();
  assert.equal(q.size, 0);
});

await testAsync('discard skips not-yet-started jobs', async () => {
  const q = new DumpQueue();
  let ran = 0;
  q.enqueue(async () => {
    await Promise.resolve();
    ran++;
  });
  q.enqueue(async () => {
    await Promise.resolve();
    ran++;
  });
  q.discard();
  await q.drain();
  assert.ok(ran <= 1);
});

await tjs.remove(tmp, { recursive: true }).catch(() => undefined);

summary();
