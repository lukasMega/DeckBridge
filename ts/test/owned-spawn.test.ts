import assert from 'tjs:assert';
import { spawnOwned, spawnsStopped, stopSpawns } from '../src/infra/owned-spawn.js';
import { fetchLatestRelease, UpdateCheckError } from '../src/infra/update-check.js';
import { sendBeacon } from '../src/infra/daily-ping.js';
import { testAsync as test, summary } from './helpers/harness.js';

// Order matters: stopSpawns() is permanent for the process.

console.log('\nowned-spawn');

await test('stopSpawns kills an in-flight child promptly', async () => {
  const p = spawnOwned(['sh', '-c', 'sleep 30'], { stdout: 'ignore', stderr: 'ignore' });
  const exited = p.wait();
  const t0 = Date.now();
  await stopSpawns();
  const { exit_status, term_signal } = await exited;
  assert.ok(Date.now() - t0 < 3000, 'settles well under the child runtime');
  assert.ok(exit_status !== 0 || Boolean(term_signal), 'child did not exit cleanly');
  assert.equal(spawnsStopped(), true);
});

await test('no spawn after stop', () => {
  assert.throws(() => spawnOwned(['sh', '-c', 'true'], { stdout: 'ignore', stderr: 'ignore' }));
});

await test('fetchLatestRelease after stop rejects as network, without spawning', async () => {
  let err: unknown;
  try {
    await fetchLatestRelease('0.0.0');
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof UpdateCheckError);
  assert.equal((err as UpdateCheckError).code, 'network');
});

await test('sendBeacon after stop resolves silently', async () => {
  await sendBeacon('x', '0.0.0');
});

summary();
