import assert from 'tjs:assert';
import { parseAckReport } from '../src/mirabox.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e: unknown) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

console.log('\nmirabox-parse: parseAckReport');

await test('K1 Pro ACK (reportId=0x04) returns correct keyIndex and stateByte', () => {
  const data = Buffer.from([0x04, 0x41, 0x43, 0x4b, 0, 0, 0x4f, 0x4b, 0, 0, 0x05, 0x01]);
  const result = parseAckReport(data, 0x04);
  assert.notEqual(result, null);
  assert.equal(result!.keyIndex, 0x05);
  assert.equal(result!.stateByte, 0x01);
});

await test('K1 Pro release (reportId=0x04) returns stateByte=0x00', () => {
  const data = Buffer.from([0x04, 0x41, 0x43, 0x4b, 0, 0, 0x4f, 0x4b, 0, 0, 0x05, 0x00]);
  const result = parseAckReport(data, 0x04);
  assert.notEqual(result, null);
  assert.equal(result!.keyIndex, 0x05);
  assert.equal(result!.stateByte, 0x00);
});

await test('293 ACK (reportId=0x00, stripped) returns correct keyIndex and stateByte', () => {
  const data = Buffer.from([0x41, 0x43, 0x4b, 0, 0, 0, 0, 0, 0, 0x03, 0x01]);
  const result = parseAckReport(data, 0x00);
  assert.notEqual(result, null);
  assert.equal(result!.keyIndex, 0x03);
  assert.equal(result!.stateByte, 0x01);
});

await test('non-ACK "SUCCESSFULLY CONNECTED" banner (reportId=0x04) returns null', () => {
  const data = Buffer.from([0x04, 0x53, 0x55, 0x43, 0x43]);
  const result = parseAckReport(data, 0x04);
  assert.equal(result, null);
});

console.log(`\n${passed} passed, ${failed} failed`);
tjs.exit(failed > 0 ? 1 : 0);
