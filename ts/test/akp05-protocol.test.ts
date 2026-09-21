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
  imageChunks,
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

test('AKP05 final image chunk clears stale tail', () => {
  const chunks = imageChunks(Uint8Array.from({ length: 1025 }, (_, index) => index & 0xff));
  assert.equal(chunks.length, 2);
  assert.equal(chunks[1]![0], 0);
  assert.equal(chunks[1]![1], 0);
  assert.equal(chunks[1]![1023], 0);
});

test('AKP05 version parser finds vendor firmware string', () => {
  assert.equal(parseVersionReport(Buffer.from('CRT V3.AKP05E.01.007\0')), 'V3.AKP05E.01.007');
});

test('AKP05 rejects JPEG lengths outside BE16', () => {
  assert.throws(() => buildBat(0x10000, 1), RangeError);
});

summaryExit();
