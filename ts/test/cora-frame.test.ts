import assert from 'tjs:assert';
import {
  CORA_MAGIC,
  CORA_HEADER_SIZE,
  encodeCoraFrame,
  CORA_FLAG_RESULT,
  CORA_FLAG_VERBATIM,
  CoraFrameReader,
} from '../src/cora-frame.js';
import { MAX_RECEIVE_BUFFER } from '../src/types.js';
import { setWebUILog, type LogLevel } from '../src/logger.js';

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

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a Buffer that contains no CORA_MAGIC sequence. */
function makeSafeGarbage(len: number, seed = 0xab): Buffer {
  const buf = Buffer.alloc(len);
  for (let i = 0; i < len; i++) buf[i] = (seed * (i + 1) * 7 + 3) & 0xff;
  // Stomp any accidental magic sequences
  for (let i = 0; i < len - 3; i++) {
    if (
      buf[i] === CORA_MAGIC[0] &&
      buf[i + 1] === CORA_MAGIC[1] &&
      buf[i + 2] === CORA_MAGIC[2] &&
      buf[i + 3] === CORA_MAGIC[3]
    ) {
      buf[i] = (buf[i] as number) ^ 0x01;
    }
  }
  return buf;
}

// ── Multi-frame drain ─────────────────────────────────────────────────────────

console.log('\nCoraFrameReader – multi-frame and split-frame');

test('two complete frames in one append → drainFrames returns both in order', () => {
  const reader = new CoraFrameReader();

  const payloadA = Buffer.from([0xaa, 0xbb, 0xcc]);
  const payloadB = Buffer.from([0x11, 0x22]);
  const frameA = encodeCoraFrame(payloadA, CORA_FLAG_VERBATIM, 0x01, 100);
  const frameB = encodeCoraFrame(payloadB, CORA_FLAG_RESULT, 0x02, 200);

  reader.append(Buffer.concat([frameA, frameB]));
  const frames = reader.drainFrames();

  assert.equal(frames.length, 2);
  assert.equal(frames[0]!.messageId, 100);
  assert.deepEqual(Array.from(frames[0]!.payload), [0xaa, 0xbb, 0xcc]);
  assert.equal(frames[1]!.messageId, 200);
  assert.deepEqual(Array.from(frames[1]!.payload), [0x11, 0x22]);
});

test('two complete frames: flags and hidOp preserved on each', () => {
  const reader = new CoraFrameReader();

  const frameA = encodeCoraFrame(Buffer.from([0x01]), CORA_FLAG_VERBATIM, 0x07, 1);
  const frameB = encodeCoraFrame(
    Buffer.from([0x02]),
    CORA_FLAG_RESULT | CORA_FLAG_VERBATIM,
    0x03,
    2,
  );

  reader.append(Buffer.concat([frameA, frameB]));
  const frames = reader.drainFrames();

  assert.equal(frames.length, 2);
  assert.equal(frames[0]!.flags, CORA_FLAG_VERBATIM);
  assert.equal(frames[0]!.hidOp, 0x07);
  assert.equal(frames[1]!.flags, CORA_FLAG_RESULT | CORA_FLAG_VERBATIM);
  assert.equal(frames[1]!.hidOp, 0x03);
});

// ── Garbage prefix / indexOf resync ──────────────────────────────────────────

console.log('\nCoraFrameReader – garbage-prefix resync');

test('garbage prefix with later valid magic → resyncs and returns the real frame', () => {
  const reader = new CoraFrameReader();

  // Build 20 bytes of garbage that contain NO CORA_MAGIC anywhere
  const garbage = makeSafeGarbage(20);
  const payload = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
  const validFrame = encodeCoraFrame(payload, 0, 0x05, 42);

  reader.append(Buffer.concat([garbage, validFrame]));
  const frames = reader.drainFrames();

  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.messageId, 42);
  assert.equal(frames[0]!.hidOp, 0x05);
  assert.deepEqual(Array.from(frames[0]!.payload), [0xde, 0xad, 0xbe, 0xef]);
});

test('garbage larger than CORA_HEADER_SIZE triggers the tail-retain path, then a real frame recovers', () => {
  // This exercises the branch: idx === -1 and buffer.length >= CORA_HEADER_SIZE
  // → buffer trimmed to last 3 bytes, then new append with a real frame works.
  const reader = new CoraFrameReader();

  const garbage = makeSafeGarbage(CORA_HEADER_SIZE + 10, 0x55);
  reader.append(garbage);
  // No frame yet; buffer trimmed to last 3 bytes (below CORA_HEADER_SIZE)
  const first = reader.drainFrames();
  assert.equal(first.length, 0);
  // Retained tail is 3 bytes
  assert.equal(reader.getBufferedLength(), 3);

  const payload = Buffer.from([0x99]);
  const validFrame = encodeCoraFrame(payload, 0, 0, 7);
  reader.append(validFrame);
  const second = reader.drainFrames();
  assert.equal(second.length, 1);
  assert.equal(second[0]!.messageId, 7);
  assert.deepEqual(Array.from(second[0]!.payload), [0x99]);
});

// ── Frame split across two appends ───────────────────────────────────────────

console.log('\nCoraFrameReader – split-frame across appends');

test('frame split after magic → first drain returns [], second returns the frame', () => {
  const reader = new CoraFrameReader();

  const payload = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);
  const wire = encodeCoraFrame(payload, CORA_FLAG_RESULT, 0x00, 55);

  // Split after the 4-byte magic (i.e. in the middle of the header)
  const splitAt = 4;
  reader.append(wire.subarray(0, splitAt) as Buffer);
  const first = reader.drainFrames();
  assert.equal(first.length, 0);

  reader.append(wire.subarray(splitAt) as Buffer);
  const second = reader.drainFrames();
  assert.equal(second.length, 1);
  assert.equal(second[0]!.messageId, 55);
  assert.deepEqual(Array.from(second[0]!.payload), [0x01, 0x02, 0x03, 0x04, 0x05]);
});

test('frame split in the middle of the payload → correct reassembly', () => {
  const reader = new CoraFrameReader();

  const payload = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0xde, 0xad]);
  const wire = encodeCoraFrame(payload, 0, 0, 99);

  // Split halfway through the payload
  const splitAt = CORA_HEADER_SIZE + 3;
  reader.append(wire.subarray(0, splitAt) as Buffer);
  assert.equal(reader.drainFrames().length, 0);

  reader.append(wire.subarray(splitAt) as Buffer);
  const frames = reader.drainFrames();
  assert.equal(frames.length, 1);
  assert.deepEqual(Array.from(frames[0]!.payload), [0xca, 0xfe, 0xba, 0xbe, 0xde, 0xad]);
});

test('frame split at the very last byte → reassembles on next append', () => {
  const reader = new CoraFrameReader();

  const payload = Buffer.from([0x77, 0x88]);
  const wire = encodeCoraFrame(payload, 0, 0, 11);

  reader.append(wire.subarray(0, wire.length - 1) as Buffer);
  assert.equal(reader.drainFrames().length, 0);

  reader.append(wire.subarray(wire.length - 1) as Buffer);
  const frames = reader.drainFrames();
  assert.equal(frames.length, 1);
  assert.deepEqual(Array.from(frames[0]!.payload), [0x77, 0x88]);
});

// ── Trailing partial header retained between drains ──────────────────────────

console.log('\nCoraFrameReader – partial header retention');

test('partial header (only magic bytes) retained after drain', () => {
  const reader = new CoraFrameReader();

  // Append only the 4-byte magic (less than CORA_HEADER_SIZE)
  reader.append(Buffer.from(CORA_MAGIC));
  assert.equal(reader.drainFrames().length, 0);
  // The 4 magic bytes must be retained (not discarded)
  assert.equal(reader.getBufferedLength(), 4);

  // Now complete the frame
  const payload = Buffer.from([0xff]);
  const wire = encodeCoraFrame(payload, 0, 0, 77);
  reader.append(wire.subarray(4) as Buffer); // rest of the frame after magic
  const frames = reader.drainFrames();
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.messageId, 77);
  assert.deepEqual(Array.from(frames[0]!.payload), [0xff]);
});

test('partial header across multiple appends accumulates correctly', () => {
  const reader = new CoraFrameReader();

  const payload = Buffer.from([0x10, 0x20, 0x30]);
  const wire = encodeCoraFrame(payload, CORA_FLAG_VERBATIM, 0x01, 33);

  // Feed one byte at a time through the entire header
  for (let i = 0; i < CORA_HEADER_SIZE; i++) {
    reader.append(wire.subarray(i, i + 1) as Buffer);
    assert.equal(reader.drainFrames().length, 0);
  }
  assert.equal(reader.getBufferedLength(), CORA_HEADER_SIZE);

  // Now append the payload
  reader.append(wire.subarray(CORA_HEADER_SIZE) as Buffer);
  const frames = reader.drainFrames();
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.messageId, 33);
  assert.deepEqual(Array.from(frames[0]!.payload), [0x10, 0x20, 0x30]);
});

// ── Combined: [garbage][frame A][partial frame B] ────────────────────────────

console.log('\nCoraFrameReader – combined garbage + partial');

test('[garbage][frame A][partial frame B] in one append → returns A, retains partial B, completes B on next append', () => {
  const reader = new CoraFrameReader();

  const garbage = makeSafeGarbage(12, 0x77);

  const payloadA = Buffer.from([0xf0, 0xf1, 0xf2]);
  const frameA = encodeCoraFrame(payloadA, 0, 0x01, 10);

  const payloadB = Buffer.from([0xe0, 0xe1, 0xe2, 0xe3]);
  const frameB = encodeCoraFrame(payloadB, CORA_FLAG_RESULT, 0x02, 20);

  // Partial of frame B: just the header (no payload bytes yet)
  const partialB = frameB.subarray(0, CORA_HEADER_SIZE) as Buffer;

  reader.append(Buffer.concat([garbage, frameA, partialB]));
  const first = reader.drainFrames();

  // Only frame A is complete
  assert.equal(first.length, 1);
  assert.equal(first[0]!.messageId, 10);
  assert.deepEqual(Array.from(first[0]!.payload), [0xf0, 0xf1, 0xf2]);

  // Partial header of B is retained
  assert.equal(reader.getBufferedLength(), CORA_HEADER_SIZE);

  // Append the payload of B to complete it
  reader.append(frameB.subarray(CORA_HEADER_SIZE) as Buffer);
  const second = reader.drainFrames();

  assert.equal(second.length, 1);
  assert.equal(second[0]!.messageId, 20);
  assert.deepEqual(Array.from(second[0]!.payload), [0xe0, 0xe1, 0xe2, 0xe3]);
});

test('[garbage][frame A][garbage][frame B] in one append → returns both frames', () => {
  const reader = new CoraFrameReader();

  const garbageA = makeSafeGarbage(8, 0x11);
  const payloadA = Buffer.from([0x01]);
  const frameA = encodeCoraFrame(payloadA, 0, 0, 1);

  const garbageB = makeSafeGarbage(6, 0x22);
  const payloadB = Buffer.from([0x02]);
  const frameB = encodeCoraFrame(payloadB, 0, 0, 2);

  reader.append(Buffer.concat([garbageA, frameA, garbageB, frameB]));
  const frames = reader.drainFrames();

  assert.equal(frames.length, 2);
  assert.equal(frames[0]!.messageId, 1);
  assert.equal(frames[1]!.messageId, 2);
});

// ── Receive-buffer overflow ──────────────────────────────────────────────────

console.log('\nCoraFrameReader – receive-buffer overflow');

test('append() beyond MAX_RECEIVE_BUFFER drops oldest bytes and logs a warn', () => {
  const reader = new CoraFrameReader();

  const logs: { level: LogLevel; component: string; message: string }[] = [];
  setWebUILog((level, component, message) => {
    logs.push({ level, component, message });
  });
  try {
    // First fill to near the limit, then push it over with a second append
    // so the overflow path trims previously-buffered bytes.
    reader.append(makeSafeGarbage(MAX_RECEIVE_BUFFER - 10, 0x11));
    reader.append(makeSafeGarbage(100, 0x22));

    assert.equal(reader.getBufferedLength(), MAX_RECEIVE_BUFFER);
    const overflowLogs = logs.filter((l) => l.level === 'warn' && l.component === 'cora');
    assert.equal(overflowLogs.length, 1, 'expected exactly one overflow warn log');
    assert.ok(/overflow/i.test(overflowLogs[0]!.message));
  } finally {
    setWebUILog(() => {});
  }
});

// ── Oversized declared payloadLength ─────────────────────────────────────────

console.log('\nCoraFrameReader – oversized declared payloadLength');

test('oversized payloadLength header is dropped, logs one warn, resyncs to next frame', () => {
  const reader = new CoraFrameReader();

  const logs: { level: LogLevel; component: string; message: string }[] = [];
  setWebUILog((level, component, message) => {
    logs.push({ level, component, message });
  });
  try {
    // Build a bad header: valid magic + flags/hidOp/messageId, but payloadLength
    // set to MAX_RECEIVE_BUFFER (impossible to ever satisfy).
    const badHeader = Buffer.alloc(CORA_HEADER_SIZE);
    CORA_MAGIC.copy(badHeader, 0);
    badHeader.writeUInt16LE(CORA_FLAG_VERBATIM, 4);
    badHeader.writeUInt8(0x01, 6);
    badHeader.writeUInt32LE(123, 8);
    badHeader.writeUInt32LE(MAX_RECEIVE_BUFFER, 12);

    const payload = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const validFrame = encodeCoraFrame(payload, CORA_FLAG_RESULT, 0x02, 200);

    reader.append(Buffer.concat([badHeader, validFrame]));
    const frames = reader.drainFrames();

    const resyncLogs = logs.filter((l) => l.level === 'warn' && l.component === 'cora');
    assert.equal(resyncLogs.length, 1, 'expected exactly one resync warn log');
    assert.ok(/payloadLength/i.test(resyncLogs[0]!.message));

    assert.equal(frames.length, 1);
    assert.equal(frames[0]!.messageId, 200);
    assert.deepEqual(Array.from(frames[0]!.payload), [0xde, 0xad, 0xbe, 0xef]);
  } finally {
    setWebUILog(() => {});
  }
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) tjs.exit(1);
