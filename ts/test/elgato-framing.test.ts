import assert from 'tjs:assert';
import { gen1WriteImage } from '../src/devices/protocol/elgato-gen1.js';
import { gen2WriteImage } from '../src/devices/protocol/elgato-gen2.js';
import { MINI_MODEL } from '../src/devices/elgato/mini.js';
import { MK2_MODEL } from '../src/devices/elgato/mk2.js';

const GEN1_PACKET_SIZE = MINI_MODEL.wire.packetSize;
const GEN2_PACKET_SIZE = MK2_MODEL.wire.packetSize;

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

// The SAME reused scratch is handed to `write` for every chunk, so collecting must
// copy — that is the contract hid-driver-base's blocking hid_write relies on.
function collect(
  writeImage: (k: number, b: Uint8Array, scratch: Uint8Array, w: (p: Uint8Array) => void) => void,
  keyIndex: number,
  bytes: Uint8Array,
  packetSize: number,
): Uint8Array[] {
  const out: Uint8Array[] = [];
  const scratch = new Uint8Array(packetSize);
  writeImage(keyIndex, bytes, scratch, (p) => out.push(new Uint8Array(p)));
  return out;
}

const body = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i + 1) & 0xff);

await test('gen2: single short chunk carries header, length and body', () => {
  const src = body(100);
  const pkts = collect(gen2WriteImage, 5, src, GEN2_PACKET_SIZE);
  assert.equal(pkts.length, 1);
  const p = pkts[0]!;
  assert.equal(p.length, 1024);
  assert.equal(p[0], 0x02);
  assert.equal(p[1], 0x07);
  assert.equal(p[2], 5); // key index
  assert.equal(p[3], 1); // isLast
  assert.equal(p[4]! | (p[5]! << 8), 100); // body length LE
  assert.equal(p[6]! | (p[7]! << 8), 0); // part 0
  assert.equal([...p.subarray(8, 108)].join(), [...src].join());
  // everything past the body is zero
  assert.equal(
    p.subarray(108).every((b) => b === 0),
    true,
  );
});

await test('gen2: multi-chunk part numbering, isLast and body split', () => {
  const payloadSize = 1024 - 8;
  const src = body(payloadSize * 2 + 7);
  const pkts = collect(gen2WriteImage, 1, src, GEN2_PACKET_SIZE);
  assert.equal(pkts.length, 3);
  pkts.forEach((p, i) => {
    const last = i === 2;
    assert.equal(p[6]! | (p[7]! << 8), i, `part ${i}`);
    assert.equal(p[3], last ? 1 : 0, `isLast ${i}`);
    assert.equal(p[4]! | (p[5]! << 8), last ? 7 : payloadSize, `bodyLen ${i}`);
  });
  // reassembled body equals the source
  const joined: number[] = [];
  pkts.forEach((p, i) => {
    const n = i === 2 ? 7 : payloadSize;
    joined.push(...p.subarray(8, 8 + n));
  });
  assert.equal(joined.join(), [...src].join());
});

await test('gen2: the last chunk has no stale bytes from the previous one', () => {
  const payloadSize = 1024 - 8;
  const pkts = collect(gen2WriteImage, 0, body(payloadSize + 3), GEN2_PACKET_SIZE);
  assert.equal(pkts.length, 2);
  // Only 3 body bytes are live; the rest of the reused buffer must be re-zeroed.
  assert.equal(
    pkts[1]!.subarray(8 + 3).every((b) => b === 0),
    true,
  );
});

await test('gen1: header layout, 1-based key index and 16-byte header', () => {
  const src = body(50);
  const pkts = collect(gen1WriteImage, 3, src, GEN1_PACKET_SIZE);
  assert.equal(pkts.length, 1);
  const p = pkts[0]!;
  assert.equal(p[0], 0x02);
  assert.equal(p[1], 0x01);
  assert.equal(p[2], 0); // part index
  assert.equal(p[3], 0x00);
  assert.equal(p[4], 1); // isLast
  assert.equal(p[5], 4); // 1-based key index
  // bytes 6..15 are padding and must be zero
  assert.equal(
    p.subarray(6, 16).every((b) => b === 0),
    true,
  );
  assert.equal([...p.subarray(16, 66)].join(), [...src].join());
});

await test('gen1: multi-chunk part numbering', () => {
  const payloadSize = 1024 - 16;
  const pkts = collect(gen1WriteImage, 0, body(payloadSize * 2), GEN1_PACKET_SIZE);
  assert.equal(pkts.length, 2);
  assert.equal(pkts[0]![2], 0);
  assert.equal(pkts[0]![4], 0);
  assert.equal(pkts[1]![2], 1);
  assert.equal(pkts[1]![4], 1);
});

await test('empty payload still emits exactly one packet', () => {
  assert.equal(collect(gen2WriteImage, 0, new Uint8Array(0), GEN2_PACKET_SIZE).length, 1);
  assert.equal(collect(gen1WriteImage, 0, new Uint8Array(0), GEN1_PACKET_SIZE).length, 1);
});

await test('an exact multiple of the payload size does not emit a trailing packet', () => {
  const pkts = collect(gen2WriteImage, 0, body((GEN2_PACKET_SIZE - 8) * 2), GEN2_PACKET_SIZE);
  assert.equal(pkts.length, 2);
  assert.equal(pkts[1]![3], 1); // last chunk flagged
});

console.log(`\n${passed} passed, ${failed} failed`);
tjs.exit(failed > 0 ? 1 : 0);
