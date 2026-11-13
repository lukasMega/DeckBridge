import assert from 'tjs:assert';
import { acquireInstanceLock, releaseInstanceLock } from '../src/infra/single-instance.js';
import { testAsync, summaryExit } from './helpers/harness.js';

const port = 47_900 + (tjs.pid % 100);

await testAsync('acquires a free lock and is idempotent for the owner', async () => {
  assert.ok(await acquireInstanceLock(port));
  assert.ok(await acquireInstanceLock(port));
  releaseInstanceLock();
});

await testAsync('refuses while another process holds the port', async () => {
  const other = await tjs.listen('tcp', '127.0.0.1', port);
  await other.opened;
  assert.equal(await acquireInstanceLock(port), false);
  other.close();
  await other.closed;
});

await testAsync('lock is free again after release', async () => {
  assert.ok(await acquireInstanceLock(port));
  releaseInstanceLock();
  assert.ok(await acquireInstanceLock(port));
  releaseInstanceLock();
});

summaryExit();
