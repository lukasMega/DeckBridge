import assert from 'tjs:assert';
import { padChunkBoundaries } from '../src/mirabox.js';

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

function seq(n: number): Buffer {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (i * 7 + 3) & 0xff;
  return b;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Reproduce the K1 Pro firmware receive bug: drop the last byte of every
// full pktSize chunk (probe rounds 1-16, jpeg-artifact-findings.md).
function firmwareReceive(wire: Buffer, pktSize: number): Buffer {
  const kept: number[] = [];
  for (let i = 0; i < wire.length; i++) {
    const posInChunk = i % pktSize;
    const chunkIsFull = wire.length - (i - posInChunk) >= pktSize;
    if (!(chunkIsFull && posInChunk === pktSize - 1)) kept.push(wire[i]!);
  }
  return Buffer.from(kept);
}

console.log('\nk1pro-chunk-pad: padChunkBoundaries');

await test('short payload (< 1023) is unchanged', () => {
  const d = seq(885);
  assert.ok(bytesEqual(padChunkBoundaries(d, 1024), d));
});

await test('pad byte lands at every chunk boundary', () => {
  const w = padChunkBoundaries(seq(4480), 1024);
  for (const at of [1023, 2047, 3071, 4095]) assert.equal(w[at], 0x00);
});

await test('wire length adds one byte per full payload group', () => {
  assert.equal(padChunkBoundaries(seq(1354), 1024).length, 1355);
  assert.equal(padChunkBoundaries(seq(4480), 1024).length, 4484);
});

await test('firmware drop reconstructs the original exactly (many sizes)', () => {
  for (const n of [1022, 1023, 1024, 1354, 2046, 2047, 2048, 2437, 4480, 5000]) {
    const d = seq(n);
    const got = firmwareReceive(padChunkBoundaries(d, 1024), 1024);
    // device may also drop the pad of a trailing exactly-full chunk; the
    // payload must survive either way, possibly with the pad still attached
    assert.ok(bytesEqual(got.subarray(0, n), d), `payload mangled for n=${n}`);
    assert.ok(got.length - n <= 1, `unexpected extra bytes for n=${n}`);
  }
});

await test('no full chunk ever ends with a payload byte', () => {
  for (const n of [1023, 1354, 2437, 4480]) {
    const w = padChunkBoundaries(seq(n), 1024);
    for (let c = 0; (c + 1) * 1024 <= w.length; c++) {
      assert.equal(w[c * 1024 + 1023], 0x00, `chunk ${c} of n=${n}`);
    }
  }
});

await test('matches the hardware-verified round-16 construction', () => {
  // round 16 padded 1354 -> 1355 and 4480 -> 4484 wire bytes (all CLEAN)
  const d = seq(1354);
  const w = padChunkBoundaries(d, 1024);
  assert.ok(bytesEqual(w.subarray(0, 1023), d.subarray(0, 1023)));
  assert.equal(w[1023], 0x00);
  assert.ok(bytesEqual(w.subarray(1024), d.subarray(1023)));
});

console.log(`\n${passed} passed, ${failed} failed`);
tjs.exit(failed > 0 ? 1 : 0);
