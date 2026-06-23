import assert from 'tjs:assert';
import { fwVersionBuf, buildFeatureResponse } from '../src/feature-response.js';
import {
  FW_VERSION_FIELD_LEN,
  CORA_FW_VERSION_OFFSET,
  CORA_SERIAL_LEN_OFFSET,
  CORA_SERIAL_DATA_OFFSET,
  FEATURE_GET_DOCK_FW,
  FEATURE_GET_QUICK_PROBE,
  FEATURE_GET_CHILD_FW,
  FEATURE_GET_DOCK_SERIAL,
  FEATURE_GET_FW_LEGACY,
  FEATURE_GET_SERIAL_LEGACY,
  FEATURE_GET_MAC,
  PAYLOAD_TYPE_FEATURE,
} from '../src/types.js';
import type { DeviceConfig } from '../src/elgato-types.js';

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

// ── fwVersionBuf ─────────────────────────────────────────────────────────────

console.log('\nfwVersionBuf');

test('short version is padded with \\0 to exactly FW_VERSION_FIELD_LEN bytes', () => {
  const version = '1.0';
  const buf = fwVersionBuf(version);
  assert.equal(buf.length, FW_VERSION_FIELD_LEN);
  // Leading bytes match the version string
  const expectedPrefix = Buffer.from(version, 'ascii');
  assert.deepEqual(Array.from(buf.subarray(0, expectedPrefix.length)), Array.from(expectedPrefix));
  // Trailing bytes are zero
  for (let i = expectedPrefix.length; i < FW_VERSION_FIELD_LEN; i++) {
    assert.equal(buf[i], 0, `byte ${i} should be 0`);
  }
});

test('empty string pads entirely with \\0 to FW_VERSION_FIELD_LEN bytes', () => {
  const buf = fwVersionBuf('');
  assert.equal(buf.length, FW_VERSION_FIELD_LEN);
  assert.ok(Array.from(buf).every((b: number) => b === 0));
});

test('over-long version is truncated to exactly FW_VERSION_FIELD_LEN bytes', () => {
  // Build a string longer than FW_VERSION_FIELD_LEN
  const longVersion = 'X'.repeat(FW_VERSION_FIELD_LEN + 5);
  const buf = fwVersionBuf(longVersion);
  assert.equal(buf.length, FW_VERSION_FIELD_LEN);
  // Content should match the first FW_VERSION_FIELD_LEN characters
  const expected = Buffer.from(longVersion.slice(0, FW_VERSION_FIELD_LEN), 'ascii');
  assert.deepEqual(Array.from(buf), Array.from(expected));
});

test('exactly FW_VERSION_FIELD_LEN version is unchanged', () => {
  const version = '1.01.016'; // length 8 == FW_VERSION_FIELD_LEN
  assert.equal(version.length, FW_VERSION_FIELD_LEN);
  const buf = fwVersionBuf(version);
  assert.equal(buf.length, FW_VERSION_FIELD_LEN);
  assert.deepEqual(Array.from(buf), Array.from(Buffer.from(version, 'ascii')));
});

// ── buildFeatureResponse ─────────────────────────────────────────────────────

console.log('\nbuildFeatureResponse');

const PACKET_SIZE = 32;

const fakeConfig: DeviceConfig = {
  dockFirmwareVersion: '1.01.016',
  childFirmwareVersion: '1.01.000',
  serialNumber: 'TESTSERIAL01',
  childSerialNumber: 'TESTSERIAL02',
  productId: 0x00a5,
  macAddress: [0x02, 0x00, 0x00, 0x00, 0x00, 0x01],
};

test('returned buffer length equals packetSize', () => {
  for (const reportId of [
    FEATURE_GET_DOCK_FW,
    FEATURE_GET_QUICK_PROBE,
    FEATURE_GET_CHILD_FW,
    FEATURE_GET_DOCK_SERIAL,
    FEATURE_GET_FW_LEGACY,
    FEATURE_GET_SERIAL_LEGACY,
    FEATURE_GET_MAC,
  ]) {
    const pkt = buildFeatureResponse(reportId, fakeConfig, PACKET_SIZE);
    assert.equal(
      pkt.length,
      PACKET_SIZE,
      `reportId 0x${reportId.toString(16)}: length should be ${PACKET_SIZE}`,
    );
  }
});

test('byte 0 = PAYLOAD_TYPE_FEATURE for all report ids', () => {
  for (const reportId of [
    FEATURE_GET_DOCK_FW,
    FEATURE_GET_QUICK_PROBE,
    FEATURE_GET_CHILD_FW,
    FEATURE_GET_DOCK_SERIAL,
    FEATURE_GET_FW_LEGACY,
    FEATURE_GET_SERIAL_LEGACY,
    FEATURE_GET_MAC,
  ]) {
    const pkt = buildFeatureResponse(reportId, fakeConfig, PACKET_SIZE);
    assert.equal(
      pkt[0],
      PAYLOAD_TYPE_FEATURE,
      `reportId 0x${reportId.toString(16)}: byte 0 should be PAYLOAD_TYPE_FEATURE`,
    );
  }
});

test('byte 1 = reportId for all report ids', () => {
  for (const reportId of [
    FEATURE_GET_DOCK_FW,
    FEATURE_GET_QUICK_PROBE,
    FEATURE_GET_CHILD_FW,
    FEATURE_GET_DOCK_SERIAL,
    FEATURE_GET_FW_LEGACY,
    FEATURE_GET_SERIAL_LEGACY,
    FEATURE_GET_MAC,
  ]) {
    const pkt = buildFeatureResponse(reportId, fakeConfig, PACKET_SIZE);
    assert.equal(pkt[1], reportId, `byte 1 should equal reportId 0x${reportId.toString(16)}`);
  }
});

test('FEATURE_GET_DOCK_FW: dockFirmwareVersion at CORA_FW_VERSION_OFFSET', () => {
  const pkt = buildFeatureResponse(FEATURE_GET_DOCK_FW, fakeConfig, PACKET_SIZE);
  const expected = fwVersionBuf(fakeConfig.dockFirmwareVersion);
  const actual = pkt.subarray(
    CORA_FW_VERSION_OFFSET,
    CORA_FW_VERSION_OFFSET + FW_VERSION_FIELD_LEN,
  );
  assert.deepEqual(Array.from(actual), Array.from(expected));
});

test('FEATURE_GET_QUICK_PROBE: dockFirmwareVersion at CORA_FW_VERSION_OFFSET', () => {
  const pkt = buildFeatureResponse(FEATURE_GET_QUICK_PROBE, fakeConfig, PACKET_SIZE);
  const expected = fwVersionBuf(fakeConfig.dockFirmwareVersion);
  const actual = pkt.subarray(
    CORA_FW_VERSION_OFFSET,
    CORA_FW_VERSION_OFFSET + FW_VERSION_FIELD_LEN,
  );
  assert.deepEqual(Array.from(actual), Array.from(expected));
});

test('FEATURE_GET_CHILD_FW: childFirmwareVersion at CORA_FW_VERSION_OFFSET', () => {
  const pkt = buildFeatureResponse(FEATURE_GET_CHILD_FW, fakeConfig, PACKET_SIZE);
  const expected = fwVersionBuf(fakeConfig.childFirmwareVersion);
  const actual = pkt.subarray(
    CORA_FW_VERSION_OFFSET,
    CORA_FW_VERSION_OFFSET + FW_VERSION_FIELD_LEN,
  );
  assert.deepEqual(Array.from(actual), Array.from(expected));
});

test('FEATURE_GET_DOCK_SERIAL: serial length byte at CORA_SERIAL_LEN_OFFSET', () => {
  const pkt = buildFeatureResponse(FEATURE_GET_DOCK_SERIAL, fakeConfig, PACKET_SIZE);
  const serial = Buffer.from(fakeConfig.serialNumber, 'ascii');
  assert.equal(pkt[CORA_SERIAL_LEN_OFFSET], serial.length);
});

test('FEATURE_GET_DOCK_SERIAL: serial bytes at CORA_SERIAL_DATA_OFFSET', () => {
  const pkt = buildFeatureResponse(FEATURE_GET_DOCK_SERIAL, fakeConfig, PACKET_SIZE);
  const serial = Buffer.from(fakeConfig.serialNumber, 'ascii');
  const actual = pkt.subarray(CORA_SERIAL_DATA_OFFSET, CORA_SERIAL_DATA_OFFSET + serial.length);
  assert.deepEqual(Array.from(actual), Array.from(serial));
});

test('FEATURE_GET_FW_LEGACY: dockFirmwareVersion at offset 2', () => {
  const pkt = buildFeatureResponse(FEATURE_GET_FW_LEGACY, fakeConfig, PACKET_SIZE);
  const expected = fwVersionBuf(fakeConfig.dockFirmwareVersion);
  const actual = pkt.subarray(2, 2 + FW_VERSION_FIELD_LEN);
  assert.deepEqual(Array.from(actual), Array.from(expected));
});

test('FEATURE_GET_SERIAL_LEGACY: serialNumber at offset 2', () => {
  const pkt = buildFeatureResponse(FEATURE_GET_SERIAL_LEGACY, fakeConfig, PACKET_SIZE);
  const serial = Buffer.from(fakeConfig.serialNumber, 'ascii');
  const actual = pkt.subarray(2, 2 + serial.length);
  assert.deepEqual(Array.from(actual), Array.from(serial));
});

test('FEATURE_GET_MAC: 6-byte macAddress is copied at offset 4', () => {
  const pkt = buildFeatureResponse(FEATURE_GET_MAC, fakeConfig, PACKET_SIZE);
  // fakeConfig.macAddress is exactly 6 bytes
  assert.equal(fakeConfig.macAddress.length, 6);
  const actual = Array.from(pkt.subarray(4, 10));
  assert.deepEqual(actual, fakeConfig.macAddress);
});

test('FEATURE_GET_MAC: non-6-byte macAddress leaves offset 4 bytes zero (guard skips copy)', () => {
  const configShortMac: DeviceConfig = {
    ...fakeConfig,
    macAddress: [0xde, 0xad, 0xbe], // only 3 bytes — guard should skip
  };
  const pkt = buildFeatureResponse(FEATURE_GET_MAC, configShortMac, PACKET_SIZE);
  const macBytes = Array.from(pkt.subarray(4, 10));
  assert.deepEqual(macBytes, [0, 0, 0, 0, 0, 0]);
});

test('FEATURE_GET_MAC: 7-byte macAddress leaves offset 4 bytes zero (guard skips copy)', () => {
  const configLongMac: DeviceConfig = {
    ...fakeConfig,
    macAddress: [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07], // 7 bytes — guard should skip
  };
  const pkt = buildFeatureResponse(FEATURE_GET_MAC, configLongMac, PACKET_SIZE);
  const macBytes = Array.from(pkt.subarray(4, 10));
  assert.deepEqual(macBytes, [0, 0, 0, 0, 0, 0]);
});

// Verify FEATURE_GET_DOCK_FW and FEATURE_GET_QUICK_PROBE produce identical payloads
// (both are the same switch case)
test('FEATURE_GET_DOCK_FW and FEATURE_GET_QUICK_PROBE produce the same fw version bytes', () => {
  const pktDock = buildFeatureResponse(FEATURE_GET_DOCK_FW, fakeConfig, PACKET_SIZE);
  const pktQuick = buildFeatureResponse(FEATURE_GET_QUICK_PROBE, fakeConfig, PACKET_SIZE);
  // Bytes from CORA_FW_VERSION_OFFSET onwards should match
  const fwDock = Array.from(
    pktDock.subarray(CORA_FW_VERSION_OFFSET, CORA_FW_VERSION_OFFSET + FW_VERSION_FIELD_LEN),
  );
  const fwQuick = Array.from(
    pktQuick.subarray(CORA_FW_VERSION_OFFSET, CORA_FW_VERSION_OFFSET + FW_VERSION_FIELD_LEN),
  );
  assert.deepEqual(fwDock, fwQuick);
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) tjs.exit(1);
