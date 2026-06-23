import assert from 'tjs:assert';
import { buildCrt, buildBat, buildLig, buildCle } from '../src/mirabox.js';
import {
  CORA_MAGIC,
  encodeCoraFrame,
  CORA_FLAG_RESULT,
  CORA_FLAG_VERBATIM,
  CoraFrameReader,
  tryDecodeCoraFrame,
} from '../src/cora-frame.js';

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

// ── Mirabox packet builders ──────────────────────────────────────────────────

console.log('\npacket builders');

const CRT_PREFIX = [0x43, 0x52, 0x54, 0x00, 0x00];

test('DIS packet: CRT prefix at bytes 0-4, DIS at 5-7, length 1024, rest zero', () => {
  const pkt = buildCrt([0x44, 0x49, 0x53]);
  assert.equal(pkt.length, 1024);
  assert.deepEqual(Array.from(pkt.slice(0, 5)), CRT_PREFIX);
  assert.deepEqual(Array.from(pkt.slice(5, 8)), [0x44, 0x49, 0x53]);
  assert.ok(pkt.slice(8).every((b: number) => b === 0));
});

test('BAT packet: buildBat(0x1F40, 13) matches USB sniff', () => {
  const pkt = buildBat(0x1f40, 13);
  assert.equal(pkt.length, 1024);
  assert.deepEqual(
    Array.from(pkt.slice(0, 13)),
    [0x43, 0x52, 0x54, 0x00, 0x00, 0x42, 0x41, 0x54, 0x00, 0x00, 0x1f, 0x40, 0x0d],
  );
});

test('LIG packet: buildLig(75) has byte 10 = 75 and LIG at 5-7', () => {
  const pkt = buildLig(75);
  assert.equal(pkt.length, 1024);
  assert.deepEqual(Array.from(pkt.slice(5, 8)), [0x4c, 0x49, 0x47]);
  assert.equal(pkt[10], 75);
});

test('CLE-all packet: buildCle(0xFF) has byte 11 = 0xFF', () => {
  const pkt = buildCle(0xff);
  assert.equal(pkt.length, 1024);
  assert.equal(pkt[11], 0xff);
});

test('STP packet: bytes 5-7 = 53 54 50', () => {
  const pkt = buildCrt([0x53, 0x54, 0x50]);
  assert.deepEqual(Array.from(pkt.slice(5, 8)), [0x53, 0x54, 0x50]);
});

test('CONNECT packet: bytes 5-11 = 43 4F 4E 4E 45 43 54', () => {
  const pkt = buildCrt([0x43, 0x4f, 0x4e, 0x4e, 0x45, 0x43, 0x54]);
  assert.deepEqual(Array.from(pkt.slice(5, 12)), [0x43, 0x4f, 0x4e, 0x4e, 0x45, 0x43, 0x54]);
});

// ── CORA framing ─────────────────────────────────────────────────────────────

console.log('\nCORA framing');

test('encodeCoraFrame produces correct wire format', () => {
  const payload = Buffer.from([0x03, 0x80, 0x00, 0x00]);
  const frame = encodeCoraFrame(payload, CORA_FLAG_RESULT | CORA_FLAG_VERBATIM, 0x00, 99);

  assert.deepEqual(Array.from(frame.subarray(0, 4)), Array.from(CORA_MAGIC));
  assert.equal(frame.readUInt16LE(4), CORA_FLAG_RESULT | CORA_FLAG_VERBATIM);
  assert.equal(frame[6], 0x00);
  assert.equal(frame.readUInt32LE(8), 99);
  assert.equal(frame.readUInt32LE(12), 4);
  assert.deepEqual(Array.from(frame.subarray(16)), [0x03, 0x80, 0x00, 0x00]);
});

test('CoraFrameReader recovers from bare byte greeting', () => {
  const reader = new CoraFrameReader();
  const garbage = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const payload = Buffer.from([0x03, 0x80]);
  const validFrame = encodeCoraFrame(payload, 0, 0, 0);

  reader.append(Buffer.concat([garbage, validFrame]));
  const frames = reader.drainFrames();

  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.messageId, 0);
  assert.deepEqual(Array.from(frames[0]!.payload), [0x03, 0x80]);
});

test('CoraFrameReader soft cap does not OOM', () => {
  const reader = new CoraFrameReader();
  const garbage = Buffer.alloc(200 * 1024);
  for (let i = 0; i < garbage.length; i++) garbage[i] = (i * 7 + 3) & 0xff;
  // Ensure no accidental CORA magic
  for (let i = 0; i < garbage.length - 4; i++) {
    if (
      garbage[i] === CORA_MAGIC[0] &&
      garbage[i + 1] === CORA_MAGIC[1] &&
      garbage[i + 2] === CORA_MAGIC[2] &&
      garbage[i + 3] === CORA_MAGIC[3]
    ) {
      garbage[i] = (garbage[i] as number) ^ 1;
    }
  }
  reader.append(garbage);
  assert.equal(reader.drainFrames().length, 0);

  const payload = Buffer.from([0x03, 0x80]);
  reader.append(encodeCoraFrame(payload, 0, 0, 0));
  const frames = reader.drainFrames();
  assert.equal(frames.length, 1);
  assert.deepEqual(Array.from(frames[0]!.payload), [0x03, 0x80]);
});

test('tryDecodeCoraFrame returns null for incomplete data', () => {
  const payload = Buffer.from([0x01, 0x02, 0x03]);
  const frame = encodeCoraFrame(payload, 0, 0, 0);
  // Feed all but last byte
  assert.equal(tryDecodeCoraFrame(Buffer.from(frame.subarray(0, frame.length - 1))), null);
});

test('tryDecodeCoraFrame returns frame for complete data', () => {
  const payload = Buffer.from([0xaa, 0xbb]);
  const wire = encodeCoraFrame(payload, 0, 0, 42);
  const decoded = tryDecodeCoraFrame(wire);
  assert.notEqual(decoded, null);
  assert.equal(decoded!.messageId, 42);
  assert.deepEqual(Array.from(decoded!.payload), [0xaa, 0xbb]);
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) tjs.exit(1);
