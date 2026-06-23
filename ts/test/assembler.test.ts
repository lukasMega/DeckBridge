import assert from 'tjs:assert';
import { assembleImageChunk, assembleGen1ImageChunk } from '../src/image-assembler.js';
import {
  MAX_IMAGE_ASSEMBLY_BYTES,
  GEN1_IMAGE_HEADER_SIZE,
  GEN1_IMAGE_KEY_OFFSET,
  GEN1_IMAGE_LAST_OFFSET,
} from '../src/types.js';

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

function makeChunkPkt(keyIndex: number, partIndex: number, isLast: boolean, data: Buffer): Buffer {
  const pkt = Buffer.alloc(1024);
  pkt[0] = 0x02;
  pkt[1] = 0x07;
  pkt[2] = keyIndex;
  pkt[3] = isLast ? 1 : 0;
  pkt.writeUInt16LE(data.length, 4);
  pkt.writeUInt16LE(partIndex, 6);
  data.copy(pkt, 8);
  return pkt;
}

function makeGen1ChunkPkt(keyIndex: number, isLast: boolean, payload: Buffer): Buffer {
  const pkt = Buffer.alloc(1024);
  pkt[0] = 0x02;
  pkt[1] = 0x01;
  pkt[GEN1_IMAGE_LAST_OFFSET] = isLast ? 1 : 0;
  pkt[GEN1_IMAGE_KEY_OFFSET] = keyIndex + 1; // gen1 key is 1-based
  payload.copy(pkt, GEN1_IMAGE_HEADER_SIZE);
  return pkt;
}

console.log('\nimage assembler');

test('single-page image assembles correctly', () => {
  const pages = new Map<number, Buffer[]>();
  const data = Buffer.from([0xff, 0xd8, 0xaa, 0xbb]);
  const pkt = makeChunkPkt(7, 0, true, data);
  const result = assembleImageChunk(pages, pkt);

  assert.notEqual(result, null);
  assert.equal(result!.keyIndex, 7);
  assert.deepEqual(Array.from(result!.data), Array.from(data));
  assert.equal(pages.size, 0);
});

test('multi-page image assembles in order', () => {
  const pages = new Map<number, Buffer[]>();
  const chunk0Data = Buffer.alloc(1016, 0xaa);
  const chunk1Data = Buffer.from([0x01, 0x02, 0x03]);

  assert.equal(assembleImageChunk(pages, makeChunkPkt(2, 0, false, chunk0Data)), null);

  const result = assembleImageChunk(pages, makeChunkPkt(2, 1, true, chunk1Data));
  assert.notEqual(result, null);
  assert.equal(result!.keyIndex, 2);
  assert.equal(result!.data.length, 1016 + 3);
  assert.deepEqual(Array.from(result!.data.subarray(0, 1016)), Array.from(chunk0Data));
  assert.deepEqual(Array.from(result!.data.subarray(1016)), Array.from(chunk1Data));
  assert.equal(pages.size, 0);
});

test('independent keys do not interfere', () => {
  const pages = new Map<number, Buffer[]>();
  const dataKey3 = Buffer.from([0x01, 0x02]);
  const dataKey7 = Buffer.from([0x03, 0x04]);
  const dataKey3Last = Buffer.from([0x05, 0x06]);

  assert.equal(assembleImageChunk(pages, makeChunkPkt(3, 0, false, dataKey3)), null);
  assert.equal(assembleImageChunk(pages, makeChunkPkt(7, 0, false, dataKey7)), null);

  const result = assembleImageChunk(pages, makeChunkPkt(3, 1, true, dataKey3Last));
  assert.notEqual(result, null);
  assert.equal(result!.keyIndex, 3);
  assert.equal(result!.data.length, dataKey3.length + dataKey3Last.length);
  assert.equal(pages.get(7)?.length, 1);
  assert.equal(pages.has(3), false);
});

test('isLast=true with single chunk returns result (no part-order validation)', () => {
  const pages = new Map<number, Buffer[]>();
  const data = Buffer.from([0xaa, 0xbb]);
  // Send only chunk with isLast=true — assembler concatenates whatever it has
  const result = assembleImageChunk(pages, makeChunkPkt(5, 1, true, data));
  assert.notEqual(result, null);
  assert.equal(result!.keyIndex, 5);
  assert.deepEqual(Array.from(result!.data), [0xaa, 0xbb]);
});

test('streaming past the cap drops the key and returns null', () => {
  const pages = new Map<number, Buffer[]>();
  const chunkSize = 1016;
  const chunksToOverflow = Math.ceil(MAX_IMAGE_ASSEMBLY_BYTES / chunkSize) + 1;

  let result: ReturnType<typeof assembleImageChunk> = null;
  for (let i = 0; i < chunksToOverflow; i++) {
    const data = Buffer.alloc(chunkSize, 0xaa);
    result = assembleImageChunk(pages, makeChunkPkt(9, i, false, data));
    if (result !== null || !pages.has(9)) break;
  }

  assert.equal(result, null);
  assert.equal(pages.has(9), false);
});

test('after a drop, a normal small image for the same key still assembles', () => {
  const pages = new Map<number, Buffer[]>();
  const chunkSize = 1016;
  const chunksToOverflow = Math.ceil(MAX_IMAGE_ASSEMBLY_BYTES / chunkSize) + 1;

  for (let i = 0; i < chunksToOverflow; i++) {
    const data = Buffer.alloc(chunkSize, 0xaa);
    const r = assembleImageChunk(pages, makeChunkPkt(9, i, false, data));
    if (r !== null || !pages.has(9)) break;
  }
  assert.equal(pages.has(9), false);

  const data = Buffer.from([0xff, 0xd8, 0x01, 0x02]);
  const result = assembleImageChunk(pages, makeChunkPkt(9, 0, true, data));
  assert.notEqual(result, null);
  assert.equal(result!.keyIndex, 9);
  assert.deepEqual(Array.from(result!.data), Array.from(data));
  assert.equal(pages.size, 0);
});

console.log('\ngen1 image assembler');

test('gen1: single-page image assembles correctly', () => {
  const pages = new Map<number, Buffer[]>();
  const data = Buffer.alloc(8, 0x42);
  data[0] = 0x42; // 'B'
  data[1] = 0x4d; // 'M'
  data.writeUInt32LE(8, 2); // bfSize
  const pkt = makeGen1ChunkPkt(3, true, data);
  const result = assembleGen1ImageChunk(pages, pkt);

  assert.notEqual(result, null);
  assert.equal(result!.keyIndex, 3);
  assert.equal(result!.format, 'bmp');
  assert.equal(pages.size, 0);
});

test('gen1: streaming past the cap drops the key and returns null', () => {
  const pages = new Map<number, Buffer[]>();
  const chunkSize = 1024 - GEN1_IMAGE_HEADER_SIZE;
  const chunksToOverflow = Math.ceil(MAX_IMAGE_ASSEMBLY_BYTES / chunkSize) + 1;

  let result: ReturnType<typeof assembleGen1ImageChunk> = null;
  for (let i = 0; i < chunksToOverflow; i++) {
    const payload = Buffer.alloc(chunkSize, 0xbb);
    result = assembleGen1ImageChunk(pages, makeGen1ChunkPkt(4, false, payload));
    if (result !== null || !pages.has(4)) break;
  }

  assert.equal(result, null);
  assert.equal(pages.has(4), false);
});

test('gen1: after a drop, a normal small image for the same key still assembles', () => {
  const pages = new Map<number, Buffer[]>();
  const chunkSize = 1024 - GEN1_IMAGE_HEADER_SIZE;
  const chunksToOverflow = Math.ceil(MAX_IMAGE_ASSEMBLY_BYTES / chunkSize) + 1;

  for (let i = 0; i < chunksToOverflow; i++) {
    const payload = Buffer.alloc(chunkSize, 0xbb);
    const r = assembleGen1ImageChunk(pages, makeGen1ChunkPkt(4, false, payload));
    if (r !== null || !pages.has(4)) break;
  }
  assert.equal(pages.has(4), false);

  const data = Buffer.alloc(8, 0x00);
  data[0] = 0x42; // 'B'
  data[1] = 0x4d; // 'M'
  data.writeUInt32LE(8, 2); // bfSize
  const result = assembleGen1ImageChunk(pages, makeGen1ChunkPkt(4, true, data));
  assert.notEqual(result, null);
  assert.equal(result!.keyIndex, 4);
  assert.equal(result!.format, 'bmp');
  assert.equal(pages.size, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) tjs.exit(1);
