import assert from 'tjs:assert';
import { DEVICE_MODELS, DEFAULT_MODEL, findModel } from '../src/devices/registry.js';
import { MK2_MODEL } from '../src/devices/elgato/mk2.js';
import { MINI_MODEL } from '../src/devices/elgato/mini.js';
import { MIRABOX_293_MODEL } from '../src/devices/mirabox/mirabox-293.js';
import { MIRABOX_293S_MODEL } from '../src/devices/mirabox/mirabox-293s.js';
import { MIRABOX_K1PRO_MODEL } from '../src/devices/mirabox/mirabox-k1pro.js';
import { deviceInputToMk2Index } from '../src/translator.js';
import {
  modelToChildGeometry,
  buildCapabilitiesPacket,
  MK2_CHILD_GEOMETRY,
} from '../src/capabilities.js';
import {
  ELGATO_VID,
  CHILD_CAPS_SERIAL_MAX_LEN,
  ELGATO_PKT_SIZE_RX,
  PKT_EVENT,
  EVENT_SUBTYPE_CAPABILITIES,
  CHILD_CAPS_VERSION,
  CHILD_CAPS_LAYOUT_TYPE,
  MANUFACTURER_STRING,
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

// ── findModel resolution ─────────────────────────────────────────────────────

console.log('\ndevice-models: findModel');

test('findModel returns MK2_MODEL for each of its PIDs', () => {
  for (const pid of MK2_MODEL.usbProductIds) {
    const result = findModel(MK2_MODEL.usbVendorId, pid);
    assert.notEqual(result, null);
    assert.equal(result!.id, 'mk2');
  }
});

test('findModel returns MINI_MODEL for each of its PIDs', () => {
  for (const pid of MINI_MODEL.usbProductIds) {
    const result = findModel(MINI_MODEL.usbVendorId, pid);
    assert.notEqual(result, null);
    assert.equal(result!.id, 'mini');
  }
});

test('findModel returns MIRABOX_293_MODEL for each of its PIDs', () => {
  for (const pid of MIRABOX_293_MODEL.usbProductIds) {
    const result = findModel(MIRABOX_293_MODEL.usbVendorId, pid);
    assert.notEqual(result, null);
    assert.equal(result!.id, 'mirabox-293');
  }
});

test('findModel returns MIRABOX_293S_MODEL for its PID', () => {
  for (const pid of MIRABOX_293S_MODEL.usbProductIds) {
    const result = findModel(MIRABOX_293S_MODEL.usbVendorId, pid);
    assert.notEqual(result, null);
    assert.equal(result!.id, 'mirabox-293s');
  }
});

test('mirabox-293s image spec uses pad/edge-clamp with sharpen disabled', () => {
  assert.equal(MIRABOX_293S_MODEL.image.resizeMode, 'pad');
  assert.equal(MIRABOX_293S_MODEL.image.padFill, 'edge');
  assert.equal(MIRABOX_293S_MODEL.image.sharpen, 0);
});

test('findModel returns MIRABOX_K1PRO_MODEL for PID 0x1015', () => {
  const result = findModel(0x6603, 0x1015);
  assert.notEqual(result, null);
  assert.equal(result!.id, 'mirabox-k1pro');
});

test('findModel returns MIRABOX_K1PRO_MODEL for PID 0x1019 (EU)', () => {
  const result = findModel(0x6603, 0x1019);
  assert.notEqual(result, null);
  assert.equal(result!.id, 'mirabox-k1pro');
});

test('findModel returns null for an unknown VID/PID pair', () => {
  assert.equal(findModel(0xdead, 0xbeef), null);
});

test('findModel returns null for a known VID but unknown PID', () => {
  assert.equal(findModel(MK2_MODEL.usbVendorId, 0xffff), null);
});

// ── DEVICE_MODELS ordering ───────────────────────────────────────────────────

console.log('\ndevice-models: DEVICE_MODELS ordering');

test('DEVICE_MODELS contains exactly 5 models', () => {
  assert.equal(DEVICE_MODELS.length, 5);
});

test('DEFAULT_MODEL is MK2_MODEL', () => {
  assert.equal(DEFAULT_MODEL.id, 'mk2');
});

test('Elgato models (mk2, mini) precede Mirabox models', () => {
  const mk2Idx = DEVICE_MODELS.findIndex((m) => m.id === 'mk2');
  const miniIdx = DEVICE_MODELS.findIndex((m) => m.id === 'mini');
  const m293Idx = DEVICE_MODELS.findIndex((m) => m.id === 'mirabox-293');
  const m293sIdx = DEVICE_MODELS.findIndex((m) => m.id === 'mirabox-293s');
  assert.ok(mk2Idx < m293Idx, 'mk2 must come before mirabox-293');
  assert.ok(mk2Idx < m293sIdx, 'mk2 must come before mirabox-293s');
  assert.ok(miniIdx < m293Idx, 'mini must come before mirabox-293');
  assert.ok(miniIdx < m293sIdx, 'mini must come before mirabox-293s');
});

test('mirabox-293 precedes mirabox-293s in DEVICE_MODELS', () => {
  const m293Idx = DEVICE_MODELS.findIndex((m) => m.id === 'mirabox-293');
  const m293sIdx = DEVICE_MODELS.findIndex((m) => m.id === 'mirabox-293s');
  assert.ok(m293Idx < m293sIdx, 'mirabox-293 must come before mirabox-293s');
});

test('mirabox-293s precedes mirabox-k1pro in DEVICE_MODELS', () => {
  const m293sIdx = DEVICE_MODELS.findIndex((m) => m.id === 'mirabox-293s');
  const k1proIdx = DEVICE_MODELS.findIndex((m) => m.id === 'mirabox-k1pro');
  assert.ok(m293sIdx < k1proIdx, 'mirabox-293s must come before mirabox-k1pro');
});

// ── keyMap permutation checks ────────────────────────────────────────────────

console.log('\ndevice-models: coraToWireImage permutation');

function assertPermutation(name: string, arr: readonly number[], keyCount: number): void {
  assert.equal(arr.length, keyCount, `${name}: coraToWireImage length should be ${keyCount}`);
  const sorted = arr.toSorted((a, b) => a - b);
  const expected = Array.from({ length: keyCount }, (_, i) => i + 1);
  assert.deepEqual(
    sorted,
    expected,
    `${name}: coraToWireImage must be a permutation of 1..${keyCount}`,
  );
}

test('mirabox-293 coraToWireImage is a permutation of 1..15', () => {
  assertPermutation(
    'mirabox-293',
    MIRABOX_293_MODEL.keyMap.coraToWireImage!,
    MIRABOX_293_MODEL.keyCount,
  );
});

test('mirabox-293s coraToWireImage is a permutation of 1..15', () => {
  assertPermutation(
    'mirabox-293s',
    MIRABOX_293S_MODEL.keyMap.coraToWireImage!,
    MIRABOX_293S_MODEL.keyCount,
  );
});

test('mirabox-k1pro coraToWireImage is a permutation of 1..6', () => {
  assertPermutation(
    'mirabox-k1pro',
    MIRABOX_K1PRO_MODEL.keyMap.coraToWireImage!,
    MIRABOX_K1PRO_MODEL.keyCount,
  );
});

test('mk2 has empty keyMap (identity mapping)', () => {
  assert.equal(MK2_MODEL.keyMap.coraToWireImage, undefined);
  assert.equal(MK2_MODEL.keyMap.wireInputToCora, undefined);
  assert.equal(MK2_MODEL.keyMap.inputOffset, undefined);
  assert.equal(MK2_MODEL.keyMap.imageOffset, undefined);
});

test('mini has empty keyMap (identity mapping)', () => {
  assert.equal(MINI_MODEL.keyMap.coraToWireImage, undefined);
  assert.equal(MINI_MODEL.keyMap.wireInputToCora, undefined);
  assert.equal(MINI_MODEL.keyMap.inputOffset, undefined);
  assert.equal(MINI_MODEL.keyMap.imageOffset, undefined);
});

// ── deviceInputToMk2Index round-trips ────────────────────────────────────────

console.log('\ndevice-models: deviceInputToMk2Index round-trips');

test('mirabox-293: deviceInputToMk2Index maps codes 1..15 into 0..14', () => {
  const seen = new Set<number>();
  for (let code = 1; code <= 15; code++) {
    const idx = deviceInputToMk2Index(code, MIRABOX_293_MODEL);
    assert.ok(idx >= 0 && idx <= 14, `code ${code} → idx ${idx} out of range`);
    assert.ok(!seen.has(idx), `code ${code} → idx ${idx} duplicated`);
    seen.add(idx);
  }
  assert.equal(seen.size, 15);
});

test('mirabox-293s: deviceInputToMk2Index maps codes 1..15 into 0..14 (valid columns)', () => {
  const seen = new Set<number>();
  for (let code = 1; code <= 15; code++) {
    const idx = deviceInputToMk2Index(code, MIRABOX_293S_MODEL);
    assert.ok(idx >= 0 && idx <= 14, `code ${code} → idx ${idx} out of range`);
    assert.ok(!seen.has(idx), `code ${code} → idx ${idx} duplicated`);
    seen.add(idx);
  }
  assert.equal(seen.size, 15);
});

test('mk2: deviceInputToMk2Index is identity (no keyMap)', () => {
  for (let code = 0; code < MK2_MODEL.keyCount; code++) {
    assert.equal(deviceInputToMk2Index(code, MK2_MODEL), code);
  }
});

// ── 293S wireInputToCora drop and bijection ───────────────────────────────────

console.log('\ndevice-models: mirabox-293s wireInputToCora');

// wireInputToCora: [-1, 4, 9, 14, 3, 8, 13, 2, 7, 12, 1, 6, 11, 0, 5, 10, -1, -1, -1]
// Index 0 → -1 (unused), indices 16/17/18 → -1 (6th column), indices 1-15 → bijection on 0..14

test('mirabox-293s wireInputToCora: index 0 maps to -1', () => {
  const wt = MIRABOX_293S_MODEL.keyMap.wireInputToCora!;
  assert.equal(wt[0], -1, 'index 0 must map to -1');
});

test('mirabox-293s wireInputToCora: indices 16, 17, 18 (6th column) map to -1', () => {
  const wt = MIRABOX_293S_MODEL.keyMap.wireInputToCora!;
  assert.equal(wt[16], -1, 'index 16 must map to -1');
  assert.equal(wt[17], -1, 'index 17 must map to -1');
  assert.equal(wt[18], -1, 'index 18 must map to -1');
});

test('mirabox-293s wireInputToCora: exactly 4 entries are -1 (index 0 and 16/17/18)', () => {
  const wt = MIRABOX_293S_MODEL.keyMap.wireInputToCora!;
  const negOnes = wt.reduce((n, v) => n + (v === -1 ? 1 : 0), 0);
  assert.equal(negOnes, 4, 'exactly 4 entries should be -1');
});

test('mirabox-293s wireInputToCora: indices 1..15 form a bijection onto 0..14', () => {
  const wt = MIRABOX_293S_MODEL.keyMap.wireInputToCora!;
  const values = wt.slice(1, 16);
  assert.equal(values.length, 15, 'should have 15 valid entries (indices 1..15)');
  const sorted = values.toSorted((a, b) => a - b);
  const expected = Array.from({ length: 15 }, (_, i) => i);
  assert.deepEqual(sorted, expected, 'indices 1..15 must be a bijection onto 0..14');
});

test('mirabox-293s: deviceInputToMk2Index returns -1 for 6th-column codes (16, 17, 18)', () => {
  assert.equal(deviceInputToMk2Index(16, MIRABOX_293S_MODEL), -1);
  assert.equal(deviceInputToMk2Index(17, MIRABOX_293S_MODEL), -1);
  assert.equal(deviceInputToMk2Index(18, MIRABOX_293S_MODEL), -1);
});

test('mirabox-293s: deviceInputToMk2Index returns -1 for code 0', () => {
  assert.equal(deviceInputToMk2Index(0, MIRABOX_293S_MODEL), -1);
});

// ── mirabox-k1pro properties ──────────────────────────────────────────────────

console.log('\ndevice-models: mirabox-k1pro');

test('mirabox-k1pro: keyCount === 6', () => {
  assert.equal(MIRABOX_K1PRO_MODEL.keyCount, 6);
});

test('mirabox-k1pro: columns === 3', () => {
  assert.equal(MIRABOX_K1PRO_MODEL.columns, 3);
});

test('mirabox-k1pro: rows === 2', () => {
  assert.equal(MIRABOX_K1PRO_MODEL.rows, 2);
});

test('mirabox-k1pro: cora.productId === 0x0063', () => {
  assert.equal(MIRABOX_K1PRO_MODEL.cora.productId, 0x0063);
});

test('mirabox-k1pro: wire.reportId === 0x04', () => {
  assert.equal(MIRABOX_K1PRO_MODEL.wire!.reportId, 0x04);
});

test('mirabox-k1pro: keyMap.coraToWireImage deep-equals [5,3,1,6,4,2]', () => {
  assert.deepEqual(Array.from(MIRABOX_K1PRO_MODEL.keyMap.coraToWireImage!), [5, 3, 1, 6, 4, 2]);
});

// ── modelToChildGeometry ─────────────────────────────────────────────────────

console.log('\ndevice-models: modelToChildGeometry');

function assertGeometry(model: {
  id: string;
  rows: number;
  columns: number;
  keyCount: number;
  keyWidth: number;
  keyHeight: number;
  name: string;
}): void {
  const geo = modelToChildGeometry(model as Parameters<typeof modelToChildGeometry>[0]);
  assert.equal(geo.rows, model.rows, `${model.id}: rows`);
  assert.equal(geo.columns, model.columns, `${model.id}: columns`);
  assert.equal(geo.keyCount, model.keyCount, `${model.id}: keyCount`);
  assert.equal(geo.keyWidth, model.keyWidth, `${model.id}: keyWidth`);
  assert.equal(geo.keyHeight, model.keyHeight, `${model.id}: keyHeight`);
  assert.equal(geo.productName, model.name, `${model.id}: productName`);
}

test('modelToChildGeometry for mk2 matches model fields', () => {
  assertGeometry(MK2_MODEL);
});

test('modelToChildGeometry for mini matches model fields', () => {
  assertGeometry(MINI_MODEL);
});

test('modelToChildGeometry for mirabox-293 matches model fields', () => {
  assertGeometry(MIRABOX_293_MODEL);
});

test('modelToChildGeometry for mirabox-293s matches model fields', () => {
  assertGeometry(MIRABOX_293S_MODEL);
});

test('MK2_CHILD_GEOMETRY constant matches mk2 model geometry', () => {
  const geo = modelToChildGeometry(MK2_MODEL);
  assert.equal(MK2_CHILD_GEOMETRY.rows, geo.rows);
  assert.equal(MK2_CHILD_GEOMETRY.columns, geo.columns);
  assert.equal(MK2_CHILD_GEOMETRY.keyCount, geo.keyCount);
  assert.equal(MK2_CHILD_GEOMETRY.keyWidth, geo.keyWidth);
  assert.equal(MK2_CHILD_GEOMETRY.keyHeight, geo.keyHeight);
  assert.equal(MK2_CHILD_GEOMETRY.productName, geo.productName);
});

// ── buildCapabilitiesPacket (non-MK.2 geometry) ───────────────────────────────

console.log('\ndevice-models: buildCapabilitiesPacket');

const FAKE_CONFIG: DeviceConfig = {
  dockFirmwareVersion: '1.00.000',
  childFirmwareVersion: '1.00.001',
  serialNumber: 'DOCKSN0001',
  childSerialNumber: 'CHILDSN0001',
  productId: 0x1234,
  macAddress: [0x00, 0x11, 0x22, 0x33, 0x44, 0x55],
};

const MINI_GEO = modelToChildGeometry(MINI_MODEL);
const MINI_PKT = buildCapabilitiesPacket(FAKE_CONFIG, 5344, MINI_GEO);

test('buildCapabilitiesPacket produces ELGATO_PKT_SIZE_RX-byte packet', () => {
  assert.equal(MINI_PKT.length, ELGATO_PKT_SIZE_RX);
});

test('buildCapabilitiesPacket byte 0 = PKT_EVENT', () => {
  assert.equal(MINI_PKT[0], PKT_EVENT);
});

test('buildCapabilitiesPacket byte 1 = EVENT_SUBTYPE_CAPABILITIES', () => {
  assert.equal(MINI_PKT[1], EVENT_SUBTYPE_CAPABILITIES);
});

test('buildCapabilitiesPacket bytes 2..3 = CHILD_CAPS_VERSION (LE)', () => {
  assert.equal(MINI_PKT.readUInt16LE(2), CHILD_CAPS_VERSION);
});

test('buildCapabilitiesPacket byte 4 = CHILD_CAPS_LAYOUT_TYPE', () => {
  assert.equal(MINI_PKT[4], CHILD_CAPS_LAYOUT_TYPE);
});

test('buildCapabilitiesPacket byte 5 = mini rows (2)', () => {
  assert.equal(MINI_PKT[5], MINI_MODEL.rows);
});

test('buildCapabilitiesPacket byte 6 = mini columns (3)', () => {
  assert.equal(MINI_PKT[6], MINI_MODEL.columns);
});

test('buildCapabilitiesPacket byte 7 = mini keyCount (6)', () => {
  assert.equal(MINI_PKT[7], MINI_MODEL.keyCount);
});

test('buildCapabilitiesPacket uint16LE at 8 = mini keyWidth (80)', () => {
  assert.equal(MINI_PKT.readUInt16LE(8), MINI_MODEL.keyWidth);
});

test('buildCapabilitiesPacket uint16LE at 10 = mini keyHeight (80)', () => {
  assert.equal(MINI_PKT.readUInt16LE(10), MINI_MODEL.keyHeight);
});

test('buildCapabilitiesPacket uint16LE at 26 = ELGATO_VID', () => {
  assert.equal(MINI_PKT.readUInt16LE(26), ELGATO_VID);
});

test('buildCapabilitiesPacket uint16LE at 28 = config.productId', () => {
  assert.equal(MINI_PKT.readUInt16LE(28), FAKE_CONFIG.productId);
});

test('buildCapabilitiesPacket offset 30 contains MANUFACTURER_STRING as ascii', () => {
  const expected = Buffer.from(MANUFACTURER_STRING + '\0', 'ascii');
  const actual = MINI_PKT.slice(30, 30 + expected.length);
  assert.deepEqual(Array.from(actual), Array.from(expected));
});

test('buildCapabilitiesPacket offset 62 contains productName as ascii (mini)', () => {
  const expected = Buffer.from(MINI_MODEL.name + '\0', 'ascii');
  const actual = MINI_PKT.slice(62, 62 + expected.length);
  assert.deepEqual(Array.from(actual), Array.from(expected));
});

test('buildCapabilitiesPacket uint16LE at 126 = port (5344)', () => {
  assert.equal(MINI_PKT.readUInt16LE(126), 5344);
});

test('buildCapabilitiesPacket serial at offset 94 matches config.childSerialNumber', () => {
  const sn = Buffer.from(FAKE_CONFIG.childSerialNumber, 'ascii');
  const actual = MINI_PKT.slice(94, 94 + sn.length);
  assert.deepEqual(Array.from(actual), Array.from(sn));
});

test('buildCapabilitiesPacket truncates over-long serial to CHILD_CAPS_SERIAL_MAX_LEN', () => {
  const longSerial = 'X'.repeat(CHILD_CAPS_SERIAL_MAX_LEN + 10);
  const config: DeviceConfig = { ...FAKE_CONFIG, childSerialNumber: longSerial };
  const pkt = buildCapabilitiesPacket(config, 5344, MINI_GEO);
  // The byte after the serial field must not have been overwritten with 'X'
  const serialBytes = pkt.slice(94, 94 + CHILD_CAPS_SERIAL_MAX_LEN);
  assert.ok(
    serialBytes.every((b) => b === 0x58 /* 'X' */),
    'all CHILD_CAPS_SERIAL_MAX_LEN serial bytes should be filled',
  );
  // Byte at 94 + CHILD_CAPS_SERIAL_MAX_LEN must be 0 (not overwritten)
  assert.equal(pkt[94 + CHILD_CAPS_SERIAL_MAX_LEN], 0, 'byte after serial field must be 0');
});

test('buildCapabilitiesPacket uses mirabox-293s geometry correctly', () => {
  const geo = modelToChildGeometry(MIRABOX_293S_MODEL);
  const pkt = buildCapabilitiesPacket(FAKE_CONFIG, 5344, geo);
  assert.equal(pkt[5], MIRABOX_293S_MODEL.rows);
  assert.equal(pkt[6], MIRABOX_293S_MODEL.columns);
  assert.equal(pkt[7], MIRABOX_293S_MODEL.keyCount);
  assert.equal(pkt.readUInt16LE(8), MIRABOX_293S_MODEL.keyWidth);
  assert.equal(pkt.readUInt16LE(10), MIRABOX_293S_MODEL.keyHeight);
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
tjs.exit(failed > 0 ? 1 : 0);
