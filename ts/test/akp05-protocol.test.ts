import assert from 'tjs:assert';
import {
  buildBat,
  buildLig,
  buildUlend,
  buildVer,
  imageChunks,
  parseVersionReport,
} from '../src/devices/ajazz/akp05-protocol.js';
import { test, summaryExit } from './helpers/harness.js';

test('AKP05 CRT builders use fixed 1024-byte packets', () => {
  for (const packet of [buildVer(), buildLig(50), buildBat(0x1f40, 11), buildUlend()]) {
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

test('AKP05 ULEND occupies offsets 5 through 9', () => {
  assert.deepEqual([...buildUlend().subarray(5, 10)], [0x55, 0x4c, 0x45, 0x4e, 0x44]);
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
