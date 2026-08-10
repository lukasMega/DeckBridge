import assert from 'tjs:assert';
import {
  deviceKeyFor,
  isStableDeviceKey,
  generateMacAddress,
  generateSerial,
  generateDeviceIdentity,
  getOrCreateDeviceIdentity,
} from '../src/device-identity.js';
import { DEFAULT_DOCK_SERIAL_NUMBER, DEFAULT_CHILD_SERIAL_NUMBER } from '../src/types.js';
import { loadSettings, saveSettings } from '../src/settings-store.js';
import type { Settings, DeviceIdentitySettings } from '../src/settings-store.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

// ── deviceKeyFor ─────────────────────────────────────────────────────────────

console.log('\ndeviceKeyFor');

await test('serial present: builds a stable usb:<serial> key (ignores the path)', () => {
  assert.equal(deviceKeyFor('DevSrvsID:4295295811', '0300D0782F51'), 'usb:0300D0782F51');
  assert.ok(isStableDeviceKey(deviceKeyFor('anything', '355499441494')));
});

await test('no serial: falls back to the HID path (unstable, not a stable key)', () => {
  assert.equal(deviceKeyFor('/dev/hidraw3'), '/dev/hidraw3');
  assert.equal(deviceKeyFor('IOService:/foo/bar@1', null), 'IOService:/foo/bar@1');
  assert.equal(deviceKeyFor('DevSrvsID:42', ''), 'DevSrvsID:42', 'empty serial → path fallback');
  assert.ok(!isStableDeviceKey(deviceKeyFor('DevSrvsID:42')), 'path key is not stable');
});

// ── deviceKeyFor: shared-serial disambiguation (modelId) ────────────────────────

console.log('\ndeviceKeyFor: shared-serial disambiguation');

await test('serial + modelId: builds a usb:<serial>:<modelId> key', () => {
  assert.equal(
    deviceKeyFor('path', '355499441494', 'mirabox-293s'),
    'usb:355499441494:mirabox-293s',
  );
});

await test('same shared serial, two different model ids → two different keys', () => {
  const keyA = deviceKeyFor('path-a', '355499441494', 'mirabox-293s');
  const keyB = deviceKeyFor('path-b', '355499441494', 'ajazz-akp153');
  assert.notEqual(keyA, keyB);
  assert.notEqual(generateMacAddress(keyA), generateMacAddress(keyB), 'MACs differ');
  const serialA = generateSerial(DEFAULT_DOCK_SERIAL_NUMBER, keyA);
  const serialB = generateSerial(DEFAULT_DOCK_SERIAL_NUMBER, keyB);
  assert.notEqual(
    serialA.substring(0, 12),
    serialB.substring(0, 12),
    'Elgato-visible 12-char prefix differs',
  );
});

await test('no modelId: byte-identical to the pre-fix deviceKeyFor output (v3/Elgato regression guard)', () => {
  assert.equal(deviceKeyFor('path', '0300D0782F51'), 'usb:0300D0782F51');
});

await test('isStableDeviceKey is true for the model-suffixed form', () => {
  assert.ok(isStableDeviceKey(deviceKeyFor('path', '355499441494', 'mirabox-293s')));
});

// ── generateMacAddress ───────────────────────────────────────────────────────

console.log('\ngenerateMacAddress');

await test('deterministic: same key → same MAC across repeated calls', () => {
  const a = generateMacAddress('key-A');
  const b = generateMacAddress('key-A');
  assert.equal(a, b);
});

await test('format: 6 colon-separated lowercase hex octets, 02: prefix', () => {
  const mac = generateMacAddress('key-A');
  const parts = mac.split(':');
  assert.equal(parts.length, 6, 'six octets');
  assert.equal(parts[0], '02', 'locally-administered prefix matches DEFAULT_MAC_ADDRESS_STRING');
  for (const p of parts) {
    assert.ok(/^[0-9a-f]{2}$/.test(p), `octet "${p}" is lowercase hex`);
  }
});

await test('no collision for a reasonable sample of distinct keys', () => {
  const macs = new Set<string>();
  for (let i = 0; i < 500; i++) macs.add(generateMacAddress(`device-${i}`));
  assert.equal(macs.size, 500, 'all 500 generated MACs are distinct');
});

// ── generateSerial ───────────────────────────────────────────────────────────

console.log('\ngenerateSerial');

await test('deterministic: same key → same serial across repeated calls', () => {
  const a = generateSerial(DEFAULT_DOCK_SERIAL_NUMBER, 'key-A');
  const b = generateSerial(DEFAULT_DOCK_SERIAL_NUMBER, 'key-A');
  assert.equal(a, b);
});

await test('substitution stays inside the first 12 chars (Elgato app pairing key)', () => {
  const serial = generateSerial(DEFAULT_DOCK_SERIAL_NUMBER, 'key-A');
  assert.equal(serial.length, DEFAULT_DOCK_SERIAL_NUMBER.length, 'length unchanged');
  assert.equal(serial.slice(0, 10), DEFAULT_DOCK_SERIAL_NUMBER.slice(0, 10), 'prefix unchanged');
  assert.equal(serial.slice(12), DEFAULT_DOCK_SERIAL_NUMBER.slice(12), 'suffix unchanged');
  assert.ok(
    /^[0-9a-z]{2}$/.test(serial.slice(10, 12)),
    'chars 10-11 are the 2-char base-36 hash suffix',
  );
});

await test('no collision (12-char app-id prefix) for a reasonable sample of distinct keys', () => {
  // Suffix space is 1296 slots (2 base-36 chars) — with 80 samples, birthday
  // math predicts ~95% distinct; 80% is a safe margin against flakiness.
  const prefixes = new Set<string>();
  const N = 80;
  for (let i = 0; i < N; i++) {
    prefixes.add(generateSerial(DEFAULT_DOCK_SERIAL_NUMBER, `device-${i}`).substring(0, 12));
  }
  assert.ok(prefixes.size > N * 0.8, `at least 80% distinct (got ${prefixes.size}/${N})`);
});

// ── generateDeviceIdentity ───────────────────────────────────────────────────

console.log('\ngenerateDeviceIdentity');

await test('produces all fields, dock/child serials independently derived', () => {
  const id = generateDeviceIdentity('key-A', 'My Dock');
  assert.equal(id.deviceKey, 'key-A');
  assert.equal(id.mdnsServiceName, 'My Dock');
  assert.equal(id.macAddress, generateMacAddress('key-A'));
  assert.equal(id.dockSerial, generateSerial(DEFAULT_DOCK_SERIAL_NUMBER, 'key-A'));
  assert.equal(id.childSerial, generateSerial(DEFAULT_CHILD_SERIAL_NUMBER, 'key-A'));
  assert.notEqual(id.dockSerial, id.childSerial, 'dock/child serials differ (different templates)');
});

// ── getOrCreateDeviceIdentity ────────────────────────────────────────────────

console.log('\ngetOrCreateDeviceIdentity');

await test('absent key: generates + appends, created=true', () => {
  const result = getOrCreateDeviceIdentity('key-A', 'My Dock', []);
  assert.equal(result.created, true);
  assert.equal(result.devices.length, 1);
  assert.equal(result.identity.deviceKey, 'key-A');
  assert.equal(result.devices[0], result.identity, 'appended entry is the returned identity');
});

await test('present key: reuses the existing entry verbatim, created=false, array unchanged', () => {
  const existing = generateDeviceIdentity('key-A', 'Renamed By User');
  const devices = [existing];
  const result = getOrCreateDeviceIdentity('key-A', 'Default Name Ignored', devices);
  assert.equal(result.created, false);
  assert.equal(result.identity, existing, 'reuses the exact stored entry (not regenerated)');
  assert.equal(
    result.identity.mdnsServiceName,
    'Renamed By User',
    'a persisted rename is not clobbered',
  );
  assert.equal(result.devices, devices, 'array reference unchanged when nothing was created');
});

await test('a second distinct key appends alongside the first, does not disturb it', () => {
  const first = getOrCreateDeviceIdentity('key-A', 'Dock A', []);
  const second = getOrCreateDeviceIdentity('key-B', 'Dock B', first.devices);
  assert.equal(second.created, true);
  assert.equal(second.devices.length, 2);
  assert.equal(second.devices[0], first.identity, 'first entry untouched');
  assert.equal(second.devices[1], second.identity, 'second entry appended');
});

// ── settings-store migration: bare shared-serial entry → suffixed key ───────────

console.log('\nloadSettings: shared-serial migration');

const MIGRATION_ROOT = `${tjs.tmpDir}/device-identity-migration-test-${tjs.pid}`;

function bareEntry(deviceKey: string): DeviceIdentitySettings {
  return {
    deviceKey,
    mdnsServiceName: 'Network Stream Deck',
    macAddress: '02:1a:2b:3c:4d:5e',
    dockSerial: 'A7FZA5190ILSAA',
    childSerial: 'A7FZA5191ILSNQ',
  };
}

await test('one bare usb:355499441494 entry: rewritten to the mirabox-293s-suffixed key', async () => {
  const dir = `${MIGRATION_ROOT}/one-bare`;
  const data: Settings = { selectedDock: 0, devices: [bareEntry('usb:355499441494')] };
  await saveSettings(data, dir);
  const result = await loadSettings(dir);
  assert.equal(result.devices?.length, 1);
  assert.equal(result.devices?.[0]?.deviceKey, 'usb:355499441494:mirabox-293s');
  // Identity fields are preserved verbatim — only deviceKey changes.
  assert.equal(result.devices?.[0]?.mdnsServiceName, 'Network Stream Deck');
  assert.equal(result.devices?.[0]?.macAddress, '02:1a:2b:3c:4d:5e');
});

await test('two bare usb:355499441494 entries: left untouched (already colliding)', async () => {
  const dir = `${MIGRATION_ROOT}/two-bare`;
  const data: Settings = {
    selectedDock: 0,
    devices: [
      { ...bareEntry('usb:355499441494'), mdnsServiceName: 'Dock A' },
      { ...bareEntry('usb:355499441494'), mdnsServiceName: 'Dock B' },
    ],
  };
  await saveSettings(data, dir);
  const result = await loadSettings(dir);
  assert.equal(result.devices?.length, 2);
  assert.ok(result.devices?.every((d) => d.deviceKey === 'usb:355499441494'));
});

await test('already-suffixed entry: left untouched, no duplicate created', async () => {
  const dir = `${MIGRATION_ROOT}/already-suffixed`;
  const data: Settings = {
    selectedDock: 0,
    devices: [bareEntry('usb:355499441494:mirabox-293s')],
  };
  await saveSettings(data, dir);
  const result = await loadSettings(dir);
  assert.equal(result.devices?.length, 1);
  assert.equal(result.devices?.[0]?.deviceKey, 'usb:355499441494:mirabox-293s');
});

await test('bare entry alongside an existing suffixed entry: bare left untouched (already migrated)', async () => {
  const dir = `${MIGRATION_ROOT}/bare-plus-suffixed`;
  const data: Settings = {
    selectedDock: 0,
    devices: [
      { ...bareEntry('usb:355499441494'), mdnsServiceName: 'Stale bare entry' },
      { ...bareEntry('usb:355499441494:mirabox-293s'), mdnsServiceName: 'Current entry' },
    ],
  };
  await saveSettings(data, dir);
  const result = await loadSettings(dir);
  assert.equal(result.devices?.length, 2);
  const keys = result.devices?.map((d) => d.deviceKey).toSorted();
  assert.deepEqual(keys, ['usb:355499441494', 'usb:355499441494:mirabox-293s']);
});

await test('unrelated bare usb: entries (v3 devices) are never touched', () => {
  // Regression guard: a normal v3 device's bare usb:<serial> key must not gain a
  // suffix — only the specific v1 shared-serial constant is a migration candidate.
  const untouched = deviceKeyFor('path', '0300D0782F51');
  assert.equal(untouched, 'usb:0300D0782F51');
});

try {
  await tjs.remove(MIGRATION_ROOT, { recursive: true });
} catch {}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) tjs.exit(1);
