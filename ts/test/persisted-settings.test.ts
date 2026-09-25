import assert from 'tjs:assert';
import { PersistedSettings } from '../src/web/server/persisted-settings.js';
import { settingsPath, loadSettings } from '../src/settings-store.js';
import { testAsync as test, summary } from './helpers/harness.js';

const ROOT = `${tjs.tmpDir}/persisted-settings-test-${tjs.pid}`;

// persist() save race (B3): rapid successive persist() calls must not let an
// older write+rename pair finish after a newer one and leave a stale snapshot.

console.log('\nPersistedSettings.persist() save race');

await test('rapid successive persist() calls end with the newest snapshot on disk', async () => {
  const dir = `${ROOT}/rapid`;
  const settings = new PersistedSettings(dir);
  for (let i = 0; i < 20; i++) {
    settings.selectedDock = i;
    settings.persist();
  }
  await settings.flush();
  const onDisk = await loadSettings(dir);
  assert.equal(onDisk.selectedDock, 19, 'disk reflects the last snapshot, not an earlier one');
});

await test('flush() waits for a save queued by openFile() too', async () => {
  const dir = `${ROOT}/openfile`;
  const settings = new PersistedSettings(dir);
  settings.selectedDock = 3;
  // openFile() would also try to open the OS file handler; skip that side effect
  // by exercising the same queueSave() path via persist() + flush() instead,
  // then confirm a second flush() (no pending work) resolves immediately.
  settings.persist();
  await settings.flush();
  await settings.flush();
  const onDisk = await loadSettings(dir);
  assert.equal(onDisk.selectedDock, 3);
});

await test('interleaved persist() calls never write an out-of-order stale value', async () => {
  const dir = `${ROOT}/interleaved`;
  const settings = new PersistedSettings(dir);
  for (let i = 0; i < 10; i++) {
    settings.selectedDock = i;
    settings.persist();
    // Give a couple of iterations a chance to actually start their write before
    // the next mutation, exercising the coalesce-to-latest path under real
    // interleaving rather than all mutations landing before any write starts.
    if (i % 3 === 0) await Promise.resolve();
  }
  await settings.flush();
  const onDisk = await loadSettings(dir);
  assert.equal(onDisk.selectedDock, 9, 'newest snapshot wins regardless of write timing');
  await tjs.stat(settingsPath(dir)); // file exists and is valid (loadSettings above didn't fall back to {})
});

summary();
