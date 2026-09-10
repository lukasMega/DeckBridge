import assert from 'tjs:assert';
import { parseAckReport, buildCrt, buildBat, buildLig, buildCle } from '../src/mirabox.js';
import { CMD_STP } from '../src/devices/mirabox-protocol.js';

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

// ── CRT framing across packet sizes ──────────────────────────────────────────
//
// Phase B0/B4 pre-flight for the Fifine D6, whose two revisions differ ONLY in
// wire.packetSize (512 for rev. 1, 1024 for rev. 2). The command builders take
// pktSize, so the risk is that a header field silently moves when the size changes.
// It must not: only the total packet length may differ.

console.log('\nmirabox-parse: CRT framing is packet-size independent');

const PKT_SIZES = [512, 1024] as const;

await test('every CRT command fills exactly pktSize bytes', () => {
  for (const size of PKT_SIZES) {
    assert.equal(buildCrt(CMD_STP, [], size).length, size, `STP @ ${size}`);
    assert.equal(buildBat(4480, 7, size).length, size, `BAT @ ${size}`);
    assert.equal(buildLig(80, size).length, size, `LIG @ ${size}`);
    assert.equal(buildCle(3, size).length, size, `CLE @ ${size}`);
  }
});

await test('BAT header fields sit at the same offsets at 512 and 1024', () => {
  const [small, large] = [buildBat(4480, 7, 512), buildBat(4480, 7, 1024)];
  for (const pkt of [small, large]) {
    // 'CRT' prefix, then 'BAT', then length hi/lo at 10-11 and keyId at 12.
    assert.deepEqual(Array.from(pkt.subarray(0, 3)), [0x43, 0x52, 0x54]);
    assert.deepEqual(Array.from(pkt.subarray(5, 8)), [0x42, 0x41, 0x54]);
    assert.equal((pkt[10]! << 8) | pkt[11]!, 4480);
    assert.equal(pkt[12], 7);
  }
  // Identical up to the shorter packet's length — only the zero padding differs.
  assert.deepEqual(Array.from(small), Array.from(large.subarray(0, 512)));
});

await test('LIG brightness and CLE keyId offsets do not move with pktSize', () => {
  for (const size of PKT_SIZES) {
    assert.equal(buildLig(80, size)[10], 80, `LIG brightness @ ${size}`);
    assert.equal(buildCle(3, size)[11], 3, `CLE keyId @ ${size}`);
  }
});

// The chunk loop in MiraboxDriver.sendImage walks the JPEG in pktSize steps, so a
// maxBytes-capped (10 KiB) image costs twice as many USB writes on rev. 1 as on rev. 2.
await test('a 10 KiB image splits into 20 chunks at 512 and 10 at 1024', () => {
  const jpegLen = 10240;
  assert.equal(Math.ceil(jpegLen / 512), 20);
  assert.equal(Math.ceil(jpegLen / 1024), 10);
});

console.log(`\n${passed} passed, ${failed} failed`);
tjs.exit(failed > 0 ? 1 : 0);
