import type { ImageAssembly } from '../src/image-assembler.js';
import assert from 'tjs:assert';
import {
  assembleImageChunk,
  assembleGen1ImageChunk,
  resetMalformedWarnThrottle,
} from '../src/image-assembler.js';
import {
  MAX_IMAGE_ASSEMBLY_BYTES,
  MAX_IMAGE_ASSEMBLY_CHUNKS,
  ELGATO_IMAGE_HEADER_SIZE,
  IMAGE_CHUNK_KEY_OFFSET,
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

/** Collect the lines `warn()` emits (logger.ts writes them via console.warn). */
function captureWarnings(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]): void => {
    lines.push(args.map((a) => String(a)).join(' '));
  };
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return lines;
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
  const pages = new Map<number, ImageAssembly>();
  const data = Buffer.from([0xff, 0xd8, 0xaa, 0xbb]);
  const pkt = makeChunkPkt(7, 0, true, data);
  const result = assembleImageChunk(pages, pkt);

  assert.notEqual(result, null);
  assert.equal(result!.keyIndex, 7);
  assert.deepEqual(Array.from(result!.data), Array.from(data));
  assert.equal(pages.size, 0);
});

test('multi-page image assembles in order', () => {
  const pages = new Map<number, ImageAssembly>();
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
  const pages = new Map<number, ImageAssembly>();
  const dataKey3 = Buffer.from([0x01, 0x02]);
  const dataKey7 = Buffer.from([0x03, 0x04]);
  const dataKey3Last = Buffer.from([0x05, 0x06]);

  assert.equal(assembleImageChunk(pages, makeChunkPkt(3, 0, false, dataKey3)), null);
  assert.equal(assembleImageChunk(pages, makeChunkPkt(7, 0, false, dataKey7)), null);

  const result = assembleImageChunk(pages, makeChunkPkt(3, 1, true, dataKey3Last));
  assert.notEqual(result, null);
  assert.equal(result!.keyIndex, 3);
  assert.equal(result!.data.length, dataKey3.length + dataKey3Last.length);
  assert.equal(pages.get(7)?.chunks.length, 1);
  assert.equal(pages.has(3), false);
});

test('isLast=true with single chunk returns result (no part-order validation)', () => {
  const pages = new Map<number, ImageAssembly>();
  const data = Buffer.from([0xaa, 0xbb]);
  // Send only chunk with isLast=true — assembler concatenates whatever it has
  const result = assembleImageChunk(pages, makeChunkPkt(5, 1, true, data));
  assert.notEqual(result, null);
  assert.equal(result!.keyIndex, 5);
  assert.deepEqual(Array.from(result!.data), [0xaa, 0xbb]);
});

test('streaming past the cap drops the key and returns null', () => {
  const pages = new Map<number, ImageAssembly>();
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
  const pages = new Map<number, ImageAssembly>();
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

test('empty nonfinal chunks never accumulate in either protocol', () => {
  const pages = new Map<number, ImageAssembly>();
  const empty = makeChunkPkt(1, 0, false, Buffer.alloc(0));
  const gen1 = makeGen1ChunkPkt(1, false, Buffer.alloc(0)).subarray(
    0,
    GEN1_IMAGE_HEADER_SIZE,
  ) as Buffer;
  for (let i = 0; i < 20_000; i++) {
    assembleImageChunk(pages, empty);
    assembleGen1ImageChunk(pages, gen1);
  }
  assert.equal(pages.size, 0);
});

test('tiny chunks hit chunk cap before byte cap in either protocol', () => {
  for (const gen1 of [false, true]) {
    const pages = new Map<number, ImageAssembly>();
    const tiny = gen1
      ? (makeGen1ChunkPkt(1, false, Buffer.from([1])).subarray(
          0,
          GEN1_IMAGE_HEADER_SIZE + 1,
        ) as Buffer)
      : makeChunkPkt(1, 0, false, Buffer.from([1]));
    const assemble = gen1 ? assembleGen1ImageChunk : assembleImageChunk;
    for (let i = 0; i < MAX_IMAGE_ASSEMBLY_CHUNKS; i++) assemble(pages, tiny);
    assert.equal(pages.get(1)?.bytes, MAX_IMAGE_ASSEMBLY_CHUNKS);
    assemble(pages, tiny);
    assert.equal(pages.size, 0);
  }
});

test('invalid gen2 lengths discard partial images', () => {
  const pages = new Map<number, ImageAssembly>();
  const start = makeChunkPkt(1, 0, false, Buffer.from([1]));
  const truncated = makeChunkPkt(1, 1, true, Buffer.from([2])).subarray(0, 8) as Buffer;
  for (const invalid of [truncated, start.subarray(0, 3) as Buffer]) {
    assembleImageChunk(pages, start);
    assert.equal(assembleImageChunk(pages, invalid), null);
    assert.equal(pages.size, 0);
  }
});

test('empty final gen2 chunk completes retained data', () => {
  const pages = new Map<number, ImageAssembly>();
  assembleImageChunk(pages, makeChunkPkt(1, 0, false, Buffer.from([1, 2])));
  const result = assembleImageChunk(pages, makeChunkPkt(1, 1, true, Buffer.alloc(0)));
  assert.deepEqual(Array.from(result!.data), [1, 2]);
  assert.equal(pages.size, 0);
});

test('gen1 short headers discard partial images', () => {
  const pages = new Map<number, ImageAssembly>();
  const start = makeGen1ChunkPkt(1, false, Buffer.from([1]));
  assembleGen1ImageChunk(pages, start);
  assert.equal(assembleGen1ImageChunk(pages, start.subarray(0, 6) as Buffer), null);
  assert.equal(pages.size, 0);
});

test('runts too short to name a key leave every assembly intact', () => {
  // gen2: the key byte is at index 2, so any length <= 2 identifies no key and
  // must not be treated as naming one (reading past the end yields undefined).
  const pages = new Map<number, ImageAssembly>();
  assembleImageChunk(pages, makeChunkPkt(1, 0, false, Buffer.from([0xaa])));
  assert.equal(pages.get(1)?.bytes, 1);
  for (let len = 0; len <= IMAGE_CHUNK_KEY_OFFSET; len++) {
    assert.equal(assembleImageChunk(pages, Buffer.alloc(len)), null, `gen2 runt len=${len}`);
  }
  assert.deepEqual(Array.from(pages.keys()), [1]);
  assert.equal(pages.get(1)?.bytes, 1);

  // gen1: the key byte is at index 5, so any length <= 5 identifies no key
  // (reading past the end yields undefined, making keyIndex NaN).
  const gen1Pages = new Map<number, ImageAssembly>();
  assembleGen1ImageChunk(gen1Pages, makeGen1ChunkPkt(1, false, Buffer.from([0xbb])));
  const retained = 1024 - GEN1_IMAGE_HEADER_SIZE;
  assert.equal(gen1Pages.get(1)?.bytes, retained);
  for (let len = 0; len <= GEN1_IMAGE_KEY_OFFSET; len++) {
    assert.equal(
      assembleGen1ImageChunk(gen1Pages, Buffer.alloc(len)),
      null,
      `gen1 runt len=${len}`,
    );
  }
  assert.deepEqual(Array.from(gen1Pages.keys()), [1]);
  assert.equal(gen1Pages.get(1)?.bytes, retained);
});

test('runts long enough to name a key drop only that key', () => {
  // gen2: lengths 3..7 carry a key byte but fall short of the 8-byte header.
  for (let len = IMAGE_CHUNK_KEY_OFFSET + 1; len < ELGATO_IMAGE_HEADER_SIZE; len++) {
    const pages = new Map<number, ImageAssembly>();
    assembleImageChunk(pages, makeChunkPkt(1, 0, false, Buffer.from([0xaa])));
    assembleImageChunk(pages, makeChunkPkt(2, 0, false, Buffer.from([0xbb])));
    const runt = makeChunkPkt(1, 0, false, Buffer.alloc(0)).subarray(0, len) as Buffer;
    assert.equal(assembleImageChunk(pages, runt), null);
    assert.deepEqual(Array.from(pages.keys()), [2], `gen2 runt len=${len} dropped the wrong keys`);
  }

  // gen1: lengths 6..15 carry a key byte but fall short of the 16-byte header.
  for (let len = GEN1_IMAGE_KEY_OFFSET + 1; len < GEN1_IMAGE_HEADER_SIZE; len++) {
    const pages = new Map<number, ImageAssembly>();
    assembleGen1ImageChunk(pages, makeGen1ChunkPkt(1, false, Buffer.from([0xaa])));
    assembleGen1ImageChunk(pages, makeGen1ChunkPkt(2, false, Buffer.from([0xbb])));
    const runt = makeGen1ChunkPkt(1, false, Buffer.alloc(0)).subarray(0, len) as Buffer;
    assert.equal(assembleGen1ImageChunk(pages, runt), null);
    assert.deepEqual(Array.from(pages.keys()), [2], `gen1 runt len=${len} dropped the wrong keys`);
  }
});

test('overflow warnings name the cap that tripped and its value', () => {
  const chunkSize = 1016;
  const byteCap = captureWarnings(() => {
    const pages = new Map<number, ImageAssembly>();
    for (let i = 0; i < Math.ceil(MAX_IMAGE_ASSEMBLY_BYTES / chunkSize) + 1; i++) {
      assembleImageChunk(pages, makeChunkPkt(9, i, false, Buffer.alloc(chunkSize, 0xaa)));
      if (!pages.has(9)) break;
    }
  });
  assert.equal(byteCap.length, 1);
  assert.ok(
    byteCap[0]!.includes(`exceeded ${MAX_IMAGE_ASSEMBLY_BYTES} bytes`),
    `byte-cap warning must name the byte limit, got: ${byteCap[0]}`,
  );

  const chunkCap = captureWarnings(() => {
    const pages = new Map<number, ImageAssembly>();
    const tiny = makeChunkPkt(1, 0, false, Buffer.from([1]));
    for (let i = 0; i <= MAX_IMAGE_ASSEMBLY_CHUNKS; i++) assembleImageChunk(pages, tiny);
  });
  assert.equal(chunkCap.length, 1);
  assert.ok(
    chunkCap[0]!.includes(`exceeded ${MAX_IMAGE_ASSEMBLY_CHUNKS} chunks`),
    `chunk-cap warning must name the chunk limit, got: ${chunkCap[0]}`,
  );
});

/** The five malformed-framing packets, one per drop reason. */
function malformedCases(): Array<{
  reason: string;
  drive: (pages: Map<number, ImageAssembly>) => void;
}> {
  const gen2Start = makeChunkPkt(1, 0, false, Buffer.from([1]));
  const gen1Start = makeGen1ChunkPkt(1, false, Buffer.from([1]));
  return [
    {
      reason: 'packet shorter than the 8-byte header',
      drive: (pages) => void assembleImageChunk(pages, gen2Start.subarray(0, 5) as Buffer),
    },
    {
      // Declares a 1-byte body but carries none: header-sized slice of a last-chunk packet.
      reason: 'declared body length exceeds the packet',
      drive: (pages) =>
        void assembleImageChunk(
          pages,
          makeChunkPkt(1, 1, true, Buffer.from([2])).subarray(
            0,
            ELGATO_IMAGE_HEADER_SIZE,
          ) as Buffer,
        ),
    },
    {
      reason: 'empty non-final chunk',
      drive: (pages) => void assembleImageChunk(pages, makeChunkPkt(1, 0, false, Buffer.alloc(0))),
    },
    {
      reason: 'packet shorter than the 16-byte header',
      drive: (pages) => void assembleGen1ImageChunk(pages, gen1Start.subarray(0, 6) as Buffer),
    },
    {
      reason: 'empty non-final chunk',
      drive: (pages) =>
        void assembleGen1ImageChunk(pages, gen1Start.subarray(0, GEN1_IMAGE_HEADER_SIZE) as Buffer),
    },
  ];
}

test('each malformed drop reports its reason and key', () => {
  for (const { reason, drive } of malformedCases()) {
    resetMalformedWarnThrottle();
    const lines = captureWarnings(() => drive(new Map<number, ImageAssembly>()));
    assert.equal(lines.length, 1, `expected exactly one warning for "${reason}"`);
    assert.ok(lines[0]!.includes(reason), `warning must name the reason, got: ${lines[0]}`);
    assert.ok(lines[0]!.includes('key 1'), `warning must name the key, got: ${lines[0]}`);
  }
});

test('repeats of the same malformed packet warn once per window', () => {
  for (const { reason, drive } of malformedCases()) {
    resetMalformedWarnThrottle();
    const lines = captureWarnings(() => {
      const pages = new Map<number, ImageAssembly>();
      for (let i = 0; i < 50; i++) drive(pages);
    });
    assert.equal(lines.length, 1, `"${reason}" flooded the log: ${lines.length} lines`);
  }
});

test('the next warning after the window reports the suppressed count', () => {
  resetMalformedWarnThrottle();
  const realNow = Date.now;
  let clock = 1_000_000;
  Date.now = (): number => clock;
  try {
    const lines = captureWarnings(() => {
      const pages = new Map<number, ImageAssembly>();
      const empty = makeChunkPkt(1, 0, false, Buffer.alloc(0));
      for (let i = 0; i < 4; i++) assembleImageChunk(pages, empty);
      clock += 10_000; // past MALFORMED_WARN_INTERVAL_MS
      assembleImageChunk(pages, empty);
    });
    assert.equal(lines.length, 2);
    assert.ok(
      lines[1]!.includes('(3 similar suppressed)'),
      `second line must carry the suppressed count, got: ${lines[1]}`,
    );
  } finally {
    Date.now = realNow;
  }
});

test('distinct reasons and protocols do not share a throttle window', () => {
  resetMalformedWarnThrottle();
  // Two gen2 reasons back to back: both warn.
  const gen2 = captureWarnings(() => {
    const pages = new Map<number, ImageAssembly>();
    assembleImageChunk(pages, makeChunkPkt(1, 0, false, Buffer.from([1])).subarray(0, 5) as Buffer);
    assembleImageChunk(pages, makeChunkPkt(1, 0, false, Buffer.alloc(0)));
  });
  assert.equal(gen2.length, 2, `distinct gen2 reasons must each warn, got: ${gen2.join(' | ')}`);

  // gen1 and gen2 share the reason text 'empty non-final chunk' — the label prefix in
  // the throttle key must keep them apart.
  resetMalformedWarnThrottle();
  const bothProtocols = captureWarnings(() => {
    const pages = new Map<number, ImageAssembly>();
    assembleImageChunk(pages, makeChunkPkt(1, 0, false, Buffer.alloc(0)));
    assembleGen1ImageChunk(
      pages,
      makeGen1ChunkPkt(1, false, Buffer.alloc(0)).subarray(0, GEN1_IMAGE_HEADER_SIZE) as Buffer,
    );
  });
  assert.equal(bothProtocols.length, 2, `gen1 and gen2 must not share a window`);
  assert.ok(bothProtocols[0]!.includes('image assembly dropped'));
  assert.ok(bothProtocols[1]!.includes('gen1 image assembly dropped'));
});

console.log('\ngen1 image assembler');

test('gen1: single-page image assembles correctly', () => {
  const pages = new Map<number, ImageAssembly>();
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
  const pages = new Map<number, ImageAssembly>();
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
  const pages = new Map<number, ImageAssembly>();
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
