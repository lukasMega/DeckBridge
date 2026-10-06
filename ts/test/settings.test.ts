import assert from 'tjs:assert';
import { PersistedSettings } from '../src/infra/settings.js';
import { settingsPath, loadSettings, saveSettings } from '../src/infra/settings-store.js';
import { testAsync as test, summary } from './helpers/harness.js';
import { makePage } from './helpers/pages.js';

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

console.log('\nPersistedSettings — standby');

const standbyDevice = (key: string, standby: unknown) => ({
  deviceKey: key,
  mdnsServiceName: 'Dock',
  macAddress: '00:11:22:33:44:55',
  dockSerial: 'A',
  childSerial: 'B',
  standby,
});

await test('load() keeps a valid standby object', async () => {
  const dir = `${ROOT}/standby-valid`;
  await saveSettings(
    { devices: [standbyDevice('usb:SB1', { idleDim: true, idleMinutes: 3 })] } as never,
    dir,
  );
  const settings = new PersistedSettings(dir);
  await settings.load();
  assert.deepEqual(settings.entryFor('usb:SB1')?.standby, { idleDim: true, idleMinutes: 3 });
  assert.equal(settings.for('usb:SB1').standby().idleMinutes, 3);
});

await test('load() drops an invalid standby but keeps the identity', async () => {
  const dir = `${ROOT}/standby-invalid`;
  await saveSettings({ devices: [standbyDevice('usb:SB2', { idleLevel: 'x' })] } as never, dir);
  const settings = new PersistedSettings(dir);
  await settings.load();
  const e = settings.entryFor('usb:SB2');
  assert.ok(e, 'identity kept');
  assert.equal(e!.macAddress, '00:11:22:33:44:55');
  assert.ok(!('standby' in e!), 'standby removed');
});

await test('importDevices() round-trips standby', async () => {
  const settings = new PersistedSettings(`${ROOT}/standby-import`);
  const standby = { night: true, nightStart: '22:00', wakeCommand: 'touch /tmp/x' };
  assert.ok(settings.importDevices([standbyDevice('usb:SB3', standby)]));
  assert.deepEqual(settings.entryFor('usb:SB3')?.standby, standby);
  await settings.flush();
});

await test('DockPrefs.standby(): runtime fallback, then persisted write', async () => {
  const settings = new PersistedSettings(`${ROOT}/standby-prefs`);
  const noEntry = settings.for('');
  assert.equal(noEntry.standby().idleDim, false, 'defaults');
  noEntry.setStandby({ idleDim: true });
  assert.equal(settings.for('usb:NONE').standby().idleDim, true, 'runtime shared');
  assert.ok(!settings.json().includes('idleDim'), 'nothing persisted');

  settings.getOrCreateIdentity('usb:SB4', 'Dock');
  const prefs = settings.for('usb:SB4');
  prefs.setStandby({ pixelShift: true });
  assert.deepEqual(settings.entryFor('usb:SB4')?.standby, { pixelShift: true });
  assert.equal(prefs.standby().pixelShift, true);
  prefs.setStandby({});
  assert.ok(!('standby' in settings.entryFor('usb:SB4')!), 'empty clears the field');
  assert.equal(prefs.standby().pixelShift, false);
  await settings.flush();
});

console.log('\nPersistedSettings — elgatoAutoRestart / pairing');

await test('setElgatoAutoRestart persists enabled + clamped delay; getters read defaults', async () => {
  const settings = new PersistedSettings(`${ROOT}/elgato-defaults`);
  assert.equal(settings.elgatoAutoRestartEnabled(), true, 'absent setting = on');
  assert.equal(settings.elgatoAutoRestartDelaySeconds(), 10, 'absent setting = default 10s');

  settings.setElgatoAutoRestart(false, 500);
  assert.equal(settings.elgatoAutoRestartEnabled(), false);
  assert.equal(settings.elgatoAutoRestartDelaySeconds(), 120, 'clamped to the max');
  await settings.flush();

  const onDisk = await loadSettings(`${ROOT}/elgato-defaults`);
  assert.equal(onDisk.elgatoAutoRestart, false);
  assert.equal(onDisk.elgatoAutoRestartDelayS, 120);
});

await test('setElgatoAutoRestart clamps a too-small delay to the min', () => {
  const settings = new PersistedSettings(`${ROOT}/elgato-clamp-min`);
  settings.setElgatoAutoRestart(true, 0);
  assert.equal(settings.elgatoAutoRestartDelaySeconds(), 3);
});

await test('setElgatoAutoRestart with no delayS leaves the current delay untouched', () => {
  const settings = new PersistedSettings(`${ROOT}/elgato-keep-delay`);
  settings.setElgatoAutoRestart(true, 20);
  settings.setElgatoAutoRestart(false);
  assert.equal(settings.elgatoAutoRestartDelaySeconds(), 20);
  assert.equal(settings.elgatoAutoRestartEnabled(), false);
});

await test('load() clamps an out-of-range persisted elgatoAutoRestartDelayS', async () => {
  const dir = `${ROOT}/elgato-load-clamp`;
  await saveSettings({ elgatoAutoRestartDelayS: 999 }, dir);
  const settings = new PersistedSettings(dir);
  await settings.load();
  assert.equal(settings.elgatoAutoRestartDelaySeconds(), 120);
});

await test('markPaired sets pairedAt once, persists, and wasPaired reflects it', async () => {
  const settings = new PersistedSettings(`${ROOT}/mark-paired`);
  settings.getOrCreateIdentity('usb:PAIR1', 'Dock');
  assert.equal(settings.wasPaired('usb:PAIR1'), false);

  assert.ok(settings.markPaired('usb:PAIR1'), 'first call sets pairedAt');
  assert.equal(settings.wasPaired('usb:PAIR1'), true);
  const firstPairedAt = settings.entryFor('usb:PAIR1')?.pairedAt;
  assert.ok(typeof firstPairedAt === 'string' && firstPairedAt.length > 0);

  assert.ok(!settings.markPaired('usb:PAIR1'), 'second call is a no-op');
  assert.equal(settings.entryFor('usb:PAIR1')?.pairedAt, firstPairedAt, 'timestamp unchanged');
  await settings.flush();

  const onDisk = await loadSettings(`${ROOT}/mark-paired`);
  assert.equal(onDisk.devices?.[0]?.pairedAt, firstPairedAt, 'pairedAt survives a save/load');
});

await test('markPaired on a deviceKey with no entry (mock mode) is a no-op', () => {
  const settings = new PersistedSettings(`${ROOT}/mark-paired-no-entry`);
  assert.equal(settings.markPaired(''), false);
  assert.equal(settings.markPaired('usb:NEVER-CREATED'), false);
  assert.equal(settings.wasPaired(''), false);
});

await test('addDocsSeen dedupes and round-trips through disk', async () => {
  const dir = `${ROOT}/docs-seen`;
  const settings = new PersistedSettings(dir);
  settings.addDocsSeen('push-api');
  settings.addDocsSeen('image-fit');
  settings.addDocsSeen('push-api');
  assert.deepEqual(settings.docsSeen, ['push-api', 'image-fit']);
  await settings.flush();

  const reloaded = new PersistedSettings(dir);
  await reloaded.load();
  assert.deepEqual(reloaded.docsSeen, ['push-api', 'image-fit']);
});

await test('load() drops docsSeen entries outside the topic-id shape', async () => {
  const dir = `${ROOT}/docs-seen-invalid`;
  await saveSettings(
    { docsSeen: ['ok', 'Bad Id', 'a,b', 42, '', 'x'.repeat(33)] as unknown as string[] },
    dir,
  );
  const settings = new PersistedSettings(dir);
  await settings.load();
  assert.deepEqual(settings.docsSeen, ['ok']);
});

await test('setDailyPingDay clears docsSeen on disk too', async () => {
  const dir = `${ROOT}/docs-seen-cleared`;
  const settings = new PersistedSettings(dir);
  settings.addDocsSeen('push-api');
  settings.setDailyPingDay('2026-10-04');
  assert.deepEqual(settings.docsSeen, []);
  await settings.flush();
  const onDisk = await loadSettings(dir);
  assert.equal(onDisk.docsSeen, undefined);
  assert.equal(onDisk.a7sDay, '2026-10-04');
});

console.log('\nPersistedSettings — saved pages');

const pagesDevice = (key: string, pages: unknown) => ({
  deviceKey: key,
  mdnsServiceName: 'Dock',
  macAddress: '00:11:22:33:44:55',
  dockSerial: 'A',
  childSerial: 'B',
  pages,
});

await test('load() round-trips valid pages and folds legacy text fields in page layouts', async () => {
  const dir = `${ROOT}/pages-valid`;
  const layout = { '16': { widget: 'text', param: 'Hi', textSize: 'fit' } };
  const pages = [makePage('p1', 'A', { extraKeys: layout as never }), makePage('p2', 'B')];
  await saveSettings({ devices: [pagesDevice('usb:PG1', pages)] } as never, dir);
  const settings = new PersistedSettings(dir);
  await settings.load();
  const loaded = settings.entryFor('usb:PG1')?.pages;
  assert.equal(loaded?.length, 2);
  assert.deepEqual(loaded?.[0]?.extraKeys, {
    '16': { widget: 'text', param: 'Hi', style: { textSize: 'fit' } },
  });
  assert.deepEqual(loaded?.[1], pages[1]);
});

await test('load() drops one invalid page and keeps the rest and the identity', async () => {
  const dir = `${ROOT}/pages-one-bad`;
  const bad = { ...makePage('p2', 'B'), hashes: ['nothex'] };
  await saveSettings(
    { devices: [pagesDevice('usb:PG2', [makePage('p1', 'A'), bad])] } as never,
    dir,
  );
  const settings = new PersistedSettings(dir);
  await settings.load();
  const entry = settings.entryFor('usb:PG2');
  assert.deepEqual(
    entry?.pages?.map((p) => p.id),
    ['p1'],
  );
  assert.equal(entry?.dockSerial, 'A');
});

await test('load() deletes a non-array pages field but keeps the identity', async () => {
  const dir = `${ROOT}/pages-not-array`;
  await saveSettings({ devices: [pagesDevice('usb:PG3', 'nope')] } as never, dir);
  const settings = new PersistedSettings(dir);
  await settings.load();
  const entry = settings.entryFor('usb:PG3');
  assert.ok(entry, 'identity kept');
  assert.ok(!('pages' in entry!));
});

await test('importDevices() salvages valid pages and keeps the first duplicate', async () => {
  const settings = new PersistedSettings(`${ROOT}/pages-import`);
  assert.ok(settings.importDevices([pagesDevice('usb:PG4', [makePage('p1', 'A')])]));
  assert.equal(settings.entryFor('usb:PG4')?.pages?.length, 1);
  const valid = makePage('p1', 'A');
  assert.ok(
    settings.importDevices([pagesDevice('usb:PG5', [valid, { id: 'x' }, makePage('p1', 'B')])]),
  );
  assert.deepEqual(settings.entryFor('usb:PG5')?.pages, [valid]);
  await settings.flush();
});

await test('setPages() needs an entry, persists, and an empty list clears the field', async () => {
  const dir = `${ROOT}/pages-set`;
  const settings = new PersistedSettings(dir);
  assert.equal(settings.for('usb:NOPE').setPages([makePage('p1', 'A')]), false);
  settings.getOrCreateIdentity('usb:PG6', 'Dock');
  const prefs = settings.for('usb:PG6');
  assert.deepEqual(prefs.pages(), []);
  assert.ok(prefs.setPages([makePage('p1', 'A')]));
  assert.equal(prefs.pages().length, 1);
  await settings.flush();
  assert.equal((await loadSettings(dir)).devices?.[0]?.pages?.length, 1);
  assert.ok(prefs.setPages([]));
  assert.ok(!('pages' in settings.entryFor('usb:PG6')!));
  await settings.flush();
});

await test('an unknown device field survives load + persist', async () => {
  const dir = `${ROOT}/unknown-field`;
  await saveSettings(
    { devices: [{ ...pagesDevice('usb:PG7', undefined), futureField: 7 }] } as never,
    dir,
  );
  const settings = new PersistedSettings(dir);
  await settings.load();
  settings.persist();
  await settings.flush();
  assert.equal((await loadSettings(dir)).devices?.[0]?.['futureField' as never], 7);
});

summary();
