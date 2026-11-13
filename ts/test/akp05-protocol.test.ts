import assert from 'tjs:assert';
import {
  buildBat,
  buildCle,
  buildConnect,
  buildDis,
  buildLig,
  buildStp,
  buildUlend,
  buildVer,
  describePacket,
  forEachImageChunk,
  parseVersionReport,
} from '../src/devices/ajazz/akp05-protocol.js';
import { test, summaryExit } from './helpers/harness.js';

test('AKP05 CRT builders use fixed 1024-byte packets', () => {
  for (const packet of [
    buildVer(),
    buildLig(50),
    buildBat(0x1f40, 11),
    buildStp(),
    buildUlend(),
    buildDis(),
    buildCle(0xff),
    buildConnect(),
  ]) {
    assert.equal(packet.length, 1024);
    assert.deepEqual([...packet.subarray(0, 3)], [0x43, 0x52, 0x54]);
  }
});

test('AKP05 BAT carries BE16 length and surface id', () => {
  const packet = buildBat(0x1f40, 11);
  assert.deepEqual([...packet.subarray(5, 8)], [0x42, 0x41, 0x54]);
  assert.equal(packet[10], 0x1f);
  assert.equal(packet[11], 0x40);
  assert.equal(packet[12], 11);
});

test('AKP05 wake/commit commands sit at offset 5', () => {
  assert.deepEqual([...buildDis().subarray(5, 8)], [0x44, 0x49, 0x53]);
  assert.deepEqual([...buildStp().subarray(5, 8)], [0x53, 0x54, 0x50]);
  assert.deepEqual([...buildUlend().subarray(5, 10)], [0x55, 0x4c, 0x45, 0x4e, 0x44]);
  assert.deepEqual([...buildConnect().subarray(5, 12)], [0x43, 0x4f, 0x4e, 0x4e, 0x45, 0x43, 0x54]);
});

test('AKP05 CLE stores the key id at offset 11', () => {
  assert.equal(buildCle(0xff)[11], 0xff);
});

test('AKP05 packet describer keeps commands and payload apart', () => {
  assert.equal(describePacket(buildConnect()), 'CRT CONNECT (heartbeat)');
  assert.equal(describePacket(buildLig(73)), 'CRT LIG brightness=73');
  assert.equal(describePacket(buildCle(0xff)), 'CRT CLE keyId=255');
});

test('AKP05 LIG stores brightness at offset 10', () => {
  assert.equal(buildLig(73)[10], 73);
});

test('AKP05 image chunks reuse one buffer and clear the final stale tail', () => {
  const jpeg = new Uint8Array(1025).fill(0xaa);
  jpeg[1024] = 0x5b; // the one byte of the second chunk — distinct from padding
  const out = new Uint8Array(1025).fill(0xee); // stale bytes from a previous packet
  const sent: number[][] = [];
  forEachImageChunk(jpeg, out, 1, () => sent.push([...out]));
  assert.equal(sent.length, 2);
  assert.equal(sent[0]![0], 0xee, 'byte before `at` (report id slot) untouched');
  assert.ok(
    sent[0]!.slice(1).every((b) => b === 0xaa),
    'first chunk is a full data slice',
  );
  assert.equal(sent[1]![1], 0x5b, 'second chunk carries the remaining data byte');
  assert.ok(
    sent[1]!.slice(2).every((b) => b === 0),
    'stale tail zero-filled',
  );
});

test('AKP05 describePacket names BAT fields and raw image data', () => {
  assert.equal(describePacket(buildBat(0x1f40, 11)), 'CRT BAT jpegLen=8000 surface=11');
  assert.equal(describePacket(new Uint8Array(1024).fill(0xff)), 'image-data chunk');
});

test('AKP05 version parser rejects reports without a version', () => {
  assert.equal(parseVersionReport(Buffer.from('ACK\0\0OK')), undefined);
});

test('AKP05 version parser finds vendor firmware string', () => {
  assert.equal(parseVersionReport(Buffer.from('CRT V3.AKP05E.01.007\0')), 'V3.AKP05E.01.007');
});

test('AKP05 rejects JPEG lengths outside BE16', () => {
  assert.throws(() => buildBat(0x10000, 1), RangeError);
});

summaryExit();
