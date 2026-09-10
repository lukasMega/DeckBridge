import assert from 'tjs:assert';
import {
  CMD,
  FIRST_CHUNK_DATA,
  HEADER_SIZE,
  PACKET_SIZE,
  buildChunks,
  buildPacket,
  chunkBoundaryOffsets,
  describeIncoming,
  describeOutgoing,
  encodeBrightness,
  encodeSmallWindow,
  formatClock,
  isPayloadSafe,
  parseIncoming,
} from '../src/devices/ulanzi/ulanzi-protocol.js';

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

// ── framing ──────────────────────────────────────────────────────────────────

console.log('\nulanzi-protocol: buildPacket');

test('buildPacket writes magic, a BIG-endian command and a LITTLE-endian length', () => {
  const pkt = buildPacket(CMD.SET_BUTTONS, 6545, new Uint8Array([0xaa, 0xbb]));
  assert.equal(pkt.length, PACKET_SIZE);
  assert.equal(pkt[0], 0x7c);
  assert.equal(pkt[1], 0x7c);
  // command 0x0001 big-endian
  assert.equal(pkt[2], 0x00);
  assert.equal(pkt[3], 0x01);
  // length 6545 = 0x00001991 little-endian
  assert.equal(pkt[4], 0x91);
  assert.equal(pkt[5], 0x19);
  assert.equal(pkt[6], 0x00);
  assert.equal(pkt[7], 0x00);
  assert.equal(pkt[8], 0xaa);
  assert.equal(pkt[9], 0xbb);
  assert.equal(pkt[10], 0x00, 'the rest of the packet must be zero-padded');
});

test('buildPacket encodes a two-byte command over 0x00ff correctly', () => {
  const pkt = buildPacket(CMD.IN_DEVICE_INFO, 0);
  assert.equal(pkt[2], 0x03);
  assert.equal(pkt[3], 0x03);
});

test('buildPacket rejects data larger than one packet payload', () => {
  let threw = false;
  try {
    buildPacket(CMD.SET_BUTTONS, FIRST_CHUNK_DATA + 1, new Uint8Array(FIRST_CHUNK_DATA + 1));
  } catch {
    threw = true;
  }
  assert.ok(threw, 'oversized packet data must throw');
});

console.log('\nulanzi-protocol: buildChunks');

// Golden shape: 6545 bytes = 1016 in the header packet + 5×1024 + a 1449-byte
// remainder → 1 + 6 packets, every one exactly 1024 bytes.
test('buildChunks splits 6545 bytes into 1 header packet + 6 raw chunks', () => {
  const payload = new Uint8Array(6545);
  for (let i = 0; i < payload.length; i++) payload[i] = (i % 251) + 1;
  const packets = buildChunks(CMD.SET_BUTTONS, payload);

  assert.equal(packets.length, 7);
  for (const pkt of packets) assert.equal(pkt.length, PACKET_SIZE);

  // Only packet 0 is framed; the rest are raw payload.
  assert.equal(packets[0]![0], 0x7c);
  assert.equal(packets[0]!.readUInt32LE(4), 6545);
  assert.equal(packets[0]![HEADER_SIZE], payload[0]);
  assert.equal(packets[1]![0], payload[FIRST_CHUNK_DATA]);
  assert.equal(packets[6]![0], payload[FIRST_CHUNK_DATA + 5 * PACKET_SIZE]);
});

test('buildChunks reassembles to the original payload', () => {
  const payload = new Uint8Array(3000);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 7) % 256;
  const packets = buildChunks(CMD.PARTIAL_UPDATE, payload);

  const out: number[] = [];
  out.push(...packets[0]!.subarray(HEADER_SIZE));
  for (const pkt of packets.slice(1)) out.push(...pkt);
  for (let i = 0; i < payload.length; i++) {
    assert.equal(out[i], payload[i], `byte ${i} must survive chunking`);
  }
});

test('a payload that fits in packet 0 yields exactly one packet', () => {
  const packets = buildChunks(CMD.SET_BUTTONS, new Uint8Array(FIRST_CHUNK_DATA));
  assert.equal(packets.length, 1);
});

test('a payload of exactly FIRST_CHUNK_DATA + 1 yields two packets', () => {
  const packets = buildChunks(CMD.SET_BUTTONS, new Uint8Array(FIRST_CHUNK_DATA + 1));
  assert.equal(packets.length, 2);
});

// ── boundary-byte rule ───────────────────────────────────────────────────────

console.log('\nulanzi-protocol: isPayloadSafe');

test('chunkBoundaryOffsets are the first byte of each headerless chunk', () => {
  assert.equal(JSON.stringify(chunkBoundaryOffsets(1016)), '[]');
  assert.equal(JSON.stringify(chunkBoundaryOffsets(1017)), '[1016]');
  assert.equal(JSON.stringify(chunkBoundaryOffsets(3000)), '[1016,2040]');
});

test('a payload with 0x00 at a chunk boundary is rejected', () => {
  const payload = new Uint8Array(3000).fill(0x41);
  payload[1016] = 0x00;
  assert.equal(isPayloadSafe(payload), false);
});

test('a payload with 0x7c at a chunk boundary is rejected', () => {
  const payload = new Uint8Array(3000).fill(0x41);
  payload[2040] = 0x7c;
  assert.equal(isPayloadSafe(payload), false);
});

test('a payload with safe boundary bytes is accepted', () => {
  const payload = new Uint8Array(3000).fill(0x41);
  assert.equal(isPayloadSafe(payload), true);
});

test('a payload short enough to need no raw chunks is always safe', () => {
  const payload = new Uint8Array(500).fill(0x00);
  assert.equal(isPayloadSafe(payload), true);
});

// ── ASCII payloads ───────────────────────────────────────────────────────────

console.log('\nulanzi-protocol: ASCII payloads');

test('encodeBrightness emits ASCII digits, not a binary byte', () => {
  assert.equal(new TextDecoder().decode(encodeBrightness(50)), '50');
  assert.equal(new TextDecoder().decode(encodeBrightness(100)), '100');
  assert.equal(new TextDecoder().decode(encodeBrightness(0)), '0');
});

test('encodeBrightness clamps out-of-range levels', () => {
  assert.equal(new TextDecoder().decode(encodeBrightness(-10)), '0');
  assert.equal(new TextDecoder().decode(encodeBrightness(140)), '100');
});

test('encodeSmallWindow keeps every field position, defaulting the hour format', () => {
  const s = new TextDecoder().decode(encodeSmallWindow({ mode: 203, time: '09:41:07' }));
  assert.equal(s, '203|||09:41:07||24H|');
});

test('encodeSmallWindow fills the stats fields when supplied', () => {
  const s = new TextDecoder().decode(
    encodeSmallWindow({ mode: 0, cpu: 12, mem: 48, time: '01:02:03', gpu: 7, hourFormat: '12H' }),
  );
  assert.equal(s, '0|12|48|01:02:03|7|12H|');
});

test('formatClock zero-pads every field', () => {
  assert.equal(formatClock(new Date(2026, 8, 10, 9, 4, 7)), '09:04:07');
});

// ── input parsing ────────────────────────────────────────────────────────────

console.log('\nulanzi-protocol: parseIncoming');

function inbound(cmd: number, payload: number[] = []): Uint8Array {
  const buf = new Uint8Array(PACKET_SIZE);
  buf[0] = 0x7c;
  buf[1] = 0x7c;
  buf[2] = (cmd >> 8) & 0xff;
  buf[3] = cmd & 0xff;
  buf[4] = payload.length & 0xff;
  buf.set(payload, HEADER_SIZE);
  return buf;
}

test('a grid key press parses category/slot/state from payload offsets 0/1/3', () => {
  const parsed = parseIncoming(inbound(CMD.IN_BUTTON, [0x01, 0x07, 0x01, 0x01]));
  assert.equal(parsed?.kind, 'button');
  assert.equal((parsed as { slotId: number }).slotId, 7);
  assert.equal((parsed as { category: number }).category, 0x01);
  assert.equal((parsed as { pressed: boolean }).pressed, true);
});

test('a grid key release reports pressed=false', () => {
  const parsed = parseIncoming(inbound(CMD.IN_BUTTON, [0x01, 0x07, 0x01, 0x00]));
  assert.equal((parsed as { pressed: boolean }).pressed, false);
});

test('the wide info window reports category 0x00 at slot 13', () => {
  const parsed = parseIncoming(inbound(CMD.IN_BUTTON, [0x00, 0x0d, 0x01, 0x01]));
  assert.equal((parsed as { category: number }).category, 0x00);
  assert.equal((parsed as { slotId: number }).slotId, 13);
});

test('DEVICE_INFO decodes the identity JSON up to its NUL', () => {
  const json = '{"DeviceType":"D200","Dversion":"5.3.1"}';
  const bytes = Array.from(new TextEncoder().encode(json));
  const parsed = parseIncoming(inbound(CMD.IN_DEVICE_INFO, bytes));
  assert.equal(parsed?.kind, 'info');
  assert.equal((parsed as { json: string }).json, json);
});

test('the ZIP ACK and the heartbeat are distinguished', () => {
  assert.equal(parseIncoming(inbound(CMD.IN_ZIP_ACK))?.kind, 'ack');
  assert.equal(parseIncoming(inbound(CMD.IN_HEARTBEAT))?.kind, 'heartbeat');
});

test('a report without the 7c7c magic is rejected', () => {
  const buf = inbound(CMD.IN_BUTTON, [0x01, 0x02, 0x01, 0x01]);
  buf[0] = 0x00;
  assert.equal(parseIncoming(buf), null);
});

test('a short read is rejected rather than read out of bounds', () => {
  assert.equal(parseIncoming(new Uint8Array([0x7c, 0x7c, 0x01])), null);
});

test('an unknown opcode is rejected', () => {
  assert.equal(parseIncoming(inbound(0x0999)), null);
});

// ── comm-log describers ──────────────────────────────────────────────────────

console.log('\nulanzi-protocol: describers');

test('describeOutgoing reports a page by its total ZIP size, not the packet size', () => {
  const packets = buildChunks(CMD.SET_BUTTONS, new Uint8Array(6545).fill(0x41));
  assert.equal(describeOutgoing(packets[0]!), 'SET_BUTTONS zip=6545B');
  assert.equal(describeOutgoing(packets[1]!), 'page-data chunk');
});

test('describeOutgoing decodes the ASCII opcodes', () => {
  const b = encodeBrightness(70);
  assert.equal(describeOutgoing(buildPacket(CMD.BRIGHTNESS, b.length, b)), 'BRIGHTNESS 70');
  assert.equal(describeOutgoing(buildPacket(CMD.LOCK, 0)), 'LOCK_SCREEN');
});

test('describeIncoming labels a press, an ack and an unknown report', () => {
  const press = parseIncoming(inbound(CMD.IN_BUTTON, [0x01, 0x03, 0x01, 0x01]));
  assert.equal(describeIncoming(press), 'BUTTON slot=3 press');
  const wide = parseIncoming(inbound(CMD.IN_BUTTON, [0x00, 0x0d, 0x01, 0x00]));
  assert.equal(describeIncoming(wide), 'BUTTON (wide window) slot=13 release');
  assert.equal(describeIncoming(parseIncoming(inbound(CMD.IN_ZIP_ACK))), 'ZIP ACK');
  assert.equal(describeIncoming(null), 'unknown input');
});

// The three destructive opcodes must not be reachable from CMD at all: 0x0004
// kills the display app until replug, 0x00fe rewrites the serial into secure
// flash, 0x00ff flips USB into ADB mode.
test('CMD defines no destructive opcode', () => {
  const values = Object.values(CMD) as number[];
  for (const forbidden of [0x0004, 0x00fe, 0x00ff]) {
    assert.equal(
      values.includes(forbidden),
      false,
      `0x${forbidden.toString(16)} must never be defined`,
    );
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
tjs.exit(failed > 0 ? 1 : 0);
