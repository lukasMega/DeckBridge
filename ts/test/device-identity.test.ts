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

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) tjs.exit(1);
