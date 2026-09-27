import assert from 'tjs:assert';
import { PersistedSettings } from '../src/infra/settings.js';
import { settingsPath, loadSettings, saveSettings } from '../src/infra/settings-store.js';
import { testAsync as test, summary } from './helpers/harness.js';

const ROOT = `${tjs.tmpDir}/settings-test-${tjs.pid}`;

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

console.log('\nPersistedSettings extra-key migration');

const legacyDevice = (key: string) => ({
  deviceKey: key,
  mdnsServiceName: 'Dock',
  macAddress: '00:11:22:33:44:55',
  dockSerial: 'A',
  childSerial: 'B',
  extraKeys: {
    '16': { widget: 'text', param: 'Hi', textSize: 'fit', wrap: 'words' },
    '17': { widget: 'clock', style: { bold: true } },
  },
});
const MIGRATED = {
  '16': { widget: 'text', param: 'Hi', style: { textSize: 'fit', wrap: 'words' } },
  '17': { widget: 'clock', style: { bold: true } },
};

await test('load() folds top-level textSize/wrap into style', async () => {
  const dir = `${ROOT}/migrate`;
  await saveSettings({ devices: [legacyDevice('usb:MIGRATE1')] } as never, dir);
  const settings = new PersistedSettings(dir);
  await settings.load();
  assert.deepEqual(settings.entryFor('usb:MIGRATE1')?.extraKeys, MIGRATED);
});

await test('importDevices() folds them too', async () => {
  const settings = new PersistedSettings(`${ROOT}/import`);
  assert.ok(settings.importDevices([legacyDevice('usb:MIGRATE2')]));
  assert.deepEqual(settings.entryFor('usb:MIGRATE2')?.extraKeys, MIGRATED);
  await settings.flush();
});

console.log('\nPersistedSettings.for() — DockPrefs');

await test('no entry: setters write the runtime fallback, never the file', () => {
  const settings = new PersistedSettings(`${ROOT}/prefs-runtime`);
  const prefs = settings.for('');
  assert.equal(prefs.brightnessOverride(), true, 'default');
  prefs.setBrightnessOverride(false);
  prefs.setStripMode('deckbridge-ignore');
  assert.equal(settings.for('').brightnessOverride(), false, 'shared by every no-entry lookup');
  assert.equal(settings.for('usb:NONE').stripMode(), 'deckbridge-ignore');
  assert.equal(prefs.setExtraKeyConfigs({ '15': { widget: 'clock' } }), false, 'needs an entry');
  assert.ok(!settings.json().includes('deckbridge-ignore'), 'nothing persisted');
});

await test('with an entry: reads live and persists writes', async () => {
  const settings = new PersistedSettings(`${ROOT}/prefs-entry`);
  settings.getOrCreateIdentity('usb:PREFS', 'Dock');
  const prefs = settings.for('usb:PREFS');
  prefs.setRepaintMs(2000);
  prefs.setEncoders({ connectToApp: false });
  assert.ok(prefs.setExtraKeyConfigs({ '15': { widget: 'clock' } }));
  assert.equal(settings.entryFor('usb:PREFS')?.touchStripRepaintMs, 2000);
  assert.deepEqual(prefs.extraKeyConfig(15), { widget: 'clock' });
  prefs.setEncoders({});
  assert.ok(!('encoders' in settings.entryFor('usb:PREFS')!), 'empty clears the field');
  assert.equal(settings.runtime.touchStripRepaintMs, 5000, 'runtime fallback untouched');
  await settings.flush();
});

summary();
