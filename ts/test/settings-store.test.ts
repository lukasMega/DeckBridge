import assert from 'tjs:assert';
import { settingsPath, loadSettings, saveSettings } from '../src/settings-store.js';
import type { Settings } from '../src/settings-store.js';
import { testAsync as test, summary } from './helpers/harness.js';

const ROOT = `${tjs.tmpDir}/settings-store-test-${tjs.pid}`;

// settingsPath

console.log('\nsettingsPath');

await test('joins cacheRoot with settings.json', () => {
  assert.equal(settingsPath(ROOT), `${ROOT}/settings.json`);
});

// loadSettings

console.log('\nloadSettings');

await test('missing file → {}', async () => {
  const result = await loadSettings(`${ROOT}/does-not-exist`);
  assert.deepEqual(result, {});
});

await test('invalid JSON → {}', async () => {
  const dir = `${ROOT}/invalid-json`;
  await tjs.makeDir(dir, { recursive: true });
  await tjs.writeFile(settingsPath(dir), 'not json{{{');
  const result = await loadSettings(dir);
  assert.deepEqual(result, {});
});

await test('JSON array → {}', async () => {
  const dir = `${ROOT}/array-json`;
  await tjs.makeDir(dir, { recursive: true });
  await tjs.writeFile(settingsPath(dir), '[1,2,3]');
  const result = await loadSettings(dir);
  assert.deepEqual(result, {});
});

// saveSettings / loadSettings round-trip

console.log('\nsaveSettings/loadSettings round-trip');

await test('write then read back returns identical data', async () => {
  const dir = `${ROOT}/roundtrip`;
  const data: Settings = {
    selectedDock: 2,
    devices: [
      {
        deviceKey: '/dev/hidraw3',
        mdnsServiceName: 'Network Stream Deck',
        macAddress: '02:1a:2b:3c:4d:5e',
        dockSerial: 'A7FZA5190ILSAA',
        childSerial: 'A7FZA5191ILSNQ',
        brightness: 42,
        brightnessOverride: true,
        imageModeOverride: 'pad-edge',
      },
    ],
  };
  await saveSettings(data, dir);
  const result = await loadSettings(dir);
  assert.deepEqual(result, data);
});

await test('saveSettings creates the cache directory if missing', async () => {
  const dir = `${ROOT}/fresh-dir`;
  await saveSettings({ selectedDock: 0 }, dir);
  const st = await tjs.stat(settingsPath(dir));
  assert.ok(st.isFile);
});

await test('second save overwrites the first (no stale tmp file left behind)', async () => {
  const dir = `${ROOT}/overwrite`;
  await saveSettings({ selectedDock: 1 }, dir);
  await saveSettings({ selectedDock: 2 }, dir);
  const result = await loadSettings(dir);
  assert.deepEqual(result, { selectedDock: 2 });
});

await test('concurrent saves do not corrupt the file (unique tmp per write)', async () => {
  const dir = `${ROOT}/concurrent`;
  await Promise.all(Array.from({ length: 10 }, (_, i) => saveSettings({ selectedDock: i }, dir)));
  // Whichever won, the file must be valid JSON with a selectedDock 0–9 — not a
  // half-written/ENOENT casualty of two writes sharing a tmp path.
  const result = await loadSettings(dir);
  assert.ok(typeof result.selectedDock === 'number', 'file is valid after concurrent saves');
  assert.ok(result.selectedDock! >= 0 && result.selectedDock! <= 9);
});

await test('devices[] with per-device settings round-trips through save/load', async () => {
  const dir = `${ROOT}/devices-roundtrip`;
  const data: Settings = {
    selectedDock: 0,
    devices: [
      {
        deviceKey: '/dev/hidraw3',
        mdnsServiceName: 'Network Stream Deck (Mirabox 293V3)',
        macAddress: '02:1a:2b:3c:4d:5e',
        dockSerial: 'A7FZA5190ILSAA',
        childSerial: 'A7FZA5191ILSNQ',
        brightness: 24,
        brightnessOverride: true,
        imageModeOverride: null,
      },
      {
        deviceKey: '/dev/hidraw5',
        mdnsServiceName: 'Network Stream Deck (Mirabox 293S)',
        macAddress: '02:aa:bb:cc:dd:ee',
        dockSerial: 'A7FZA5190I01AA',
        childSerial: 'A7FZA5191I01NQ',
        brightness: 55,
        brightnessOverride: true,
        imageModeOverride: 'pad-edge',
      },
    ],
  };
  await saveSettings(data, dir);
  const result = await loadSettings(dir);
  assert.deepEqual(result, data, 'devices[] entries survive a save/load round-trip verbatim');
});

await test('logLevel and modelOverrides round-trip through save/load', async () => {
  const dir = `${ROOT}/tuning-roundtrip`;
  const data: Settings = {
    selectedDock: 0,
    logLevel: 'debug',
    modelOverrides: {
      'ajazz-akp153e-rev2': {
        image: { rotate: 180, flipV: true },
        keyMap: { wireInputToCora: [-1, 10, 11, 12] },
      },
    },
  };
  await saveSettings(data, dir);
  assert.deepEqual(await loadSettings(dir), data);
});

await test('a file without the new keys still loads (purely additive schema)', async () => {
  const dir = `${ROOT}/legacy-file`;
  await tjs.makeDir(dir, { recursive: true });
  await tjs.writeFile(settingsPath(dir), JSON.stringify({ selectedDock: 1 }));
  const result = await loadSettings(dir);
  assert.equal(result.selectedDock, 1);
  assert.equal(result.logLevel, undefined);
  assert.equal(result.modelOverrides, undefined);
});

// Cleanup + summary

try {
  await tjs.remove(ROOT, { recursive: true });
} catch {}

summary();
