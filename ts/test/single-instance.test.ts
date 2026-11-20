import assert from 'tjs:assert';
import {
  acquireInstanceLock,
  alreadyRunningMessage,
  releaseInstanceLock,
} from '../src/infra/single-instance.js';
import { test, testAsync, summaryExit } from './helpers/harness.js';

// A fixed port flaked on CI (EADDRINUSE: it sits in Linux's ephemeral range), so let the OS pick.
const probe = await tjs.listen('tcp', '127.0.0.1', 0);
const { localPort: port } = await probe.opened;
probe.close();
await probe.closed;

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

test('refusal message names port and per-OS kill command', () => {
  const mac = alreadyRunningMessage('macOS', 44_659);
  assert.ok(mac.includes('lsof -nP -iTCP:44659'));
  assert.ok(mac.includes('pkill -x deckbridge'));
  const win = alreadyRunningMessage('Windows', 44_659);
  assert.ok(win.includes('taskkill /PID'));
  assert.ok(!win.includes('lsof'));
});

summaryExit();
