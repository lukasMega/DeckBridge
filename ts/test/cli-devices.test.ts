import assert from 'tjs:assert';
import { toDeviceRow, formatDeviceTable } from '../src/cli-devices.js';
import type { EnumeratedDevice } from '../src/cli-devices.js';
import { MK2_MODEL } from '../src/devices/elgato/mk2.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

// ── toDeviceRow ───────────────────────────────────────────────────────────────

console.log('\ntoDeviceRow');

test('known VID/PID with a path+serial → matched row', () => {
  const dev: EnumeratedDevice = {
    vendorId: MK2_MODEL.usbVendorId,
    productId: MK2_MODEL.usbProductIds[0]!,
    serial: 'ABC123',
    path: '/dev/hidraw0',
  };
  const row = toDeviceRow(dev);
  assert.equal(row.model, MK2_MODEL.name);
  assert.equal(row.vidPid, '0fd9:0080');
  assert.equal(row.serial, 'ABC123');
  assert.equal(row.path, '/dev/hidraw0');
  assert.equal(row.supported, 'yes');
});

test('known VID/PID with no path/serial (presence-only) → dashes', () => {
  const row = toDeviceRow({
    vendorId: MK2_MODEL.usbVendorId,
    productId: MK2_MODEL.usbProductIds[0]!,
    serial: null,
    path: null,
  });
  assert.equal(row.serial, '-');
  assert.equal(row.path, '-');
  assert.equal(row.supported, 'yes');
});

test('unknown VID/PID → "unknown" model, not supported', () => {
  const row = toDeviceRow({ vendorId: 0xdead, productId: 0xbeef, serial: null, path: null });
  assert.equal(row.model, 'unknown');
  assert.equal(row.vidPid, 'dead:beef');
  assert.equal(row.supported, 'no');
});

// ── formatDeviceTable ─────────────────────────────────────────────────────────

console.log('\nformatDeviceTable');

test('empty list → "no devices found"', () => {
  assert.equal(formatDeviceTable([]), 'no devices found');
});

test('non-empty list → header + one line per row, columns aligned', () => {
  const rows = [
    toDeviceRow({
      vendorId: MK2_MODEL.usbVendorId,
      productId: MK2_MODEL.usbProductIds[0]!,
      serial: 'ABC123',
      path: '/dev/hidraw0',
    }),
  ];
  const table = formatDeviceTable(rows);
  const lines = table.split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[0]!.startsWith('MODEL'));
  assert.ok(lines[0]!.includes('VID:PID'));
  assert.ok(lines[1]!.includes(MK2_MODEL.name));
  assert.ok(lines[1]!.includes('0fd9:0080'));
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) tjs.exit(1);
