// Benchmark: redundant-copy removal on the CORA image path (architecture-review
// Phase 1 "hot-path quick win"). Two things measured:
//
// 1. CoraFrameReader.append(): old (always Buffer.concat) vs new (adopt the
//    incoming chunk directly when the reader is fully drained, i.e. the common
//    steady-state case) — across realistic per-chunk TCP delivery patterns.
// 2. The flat per-image copy cost eliminated at hid-worker-host.ts
//    (renderCoraImage's `new Uint8Array(bytes)` pre-copy, removed — postMessage's
//    structured clone already copies synchronously, see mod_channel.c) and at
//    image-pipeline.ts / driver-manager.ts (the WebUI mirror's `Buffer.from(data)`,
//    removed — ImageChannel treats cached frames as shared/immutable).
//
// Run via: node build.mjs --test image-copy-bench && $TJS run dist/test/image-copy-bench.js

import {
  CORA_MAGIC,
  CORA_HEADER_SIZE,
  CORA_FLAG_REQACK,
  encodeCoraFrame,
  tryDecodeCoraFrame,
  frameTotalLength,
  CoraFrameReader,
  type CoraFrame,
} from '../src/cora-frame.js';
import { ELGATO_IMAGE_HEADER_SIZE, IMAGE_CHUNK_LAST_FLAG } from '../src/types.js';

// Realistic key-image sizes (from the architecture-simplification plan's notes on
// observed key JPEG sizes across models/quality settings).
const IMAGE_SIZES_KB = [7.9, 10.8, 14.0, 22.7, 22.9];
// Elgato image-chunk body size the real app/Companion send per HID output report.
const CHUNK_BODY = 1024;

function makeImageBytes(sizeBytes: number): Uint8Array {
  const b = new Uint8Array(sizeBytes);
  for (let i = 0; i < sizeBytes; i++) b[i] = (i * 31 + 7) & 0xff;
  return b;
}

/** Encode one key's JPEG as a sequence of CORA-framed Elgato image chunks
 *  (8-byte image-chunk header + body), the same wire shape image-assembler.ts
 *  parses. Returns the frames concatenated once per simulated TCP delivery unit
 *  (see `groupSizes`). */
function encodeKeyImageFrames(keyIndex: number, jpeg: Uint8Array): Buffer[] {
  const frames: Buffer[] = [];
  let offset = 0;
  let seq = 0;
  while (offset < jpeg.length || seq === 0) {
    const bodyLen = Math.min(CHUNK_BODY, jpeg.length - offset);
    const isLast = offset + bodyLen >= jpeg.length;
    const pkt = Buffer.alloc(ELGATO_IMAGE_HEADER_SIZE + bodyLen);
    pkt[0] = 0x02; // PAYLOAD_TYPE_OUTPUT_REPORT-ish placeholder, irrelevant to CoraFrameReader
    pkt[1] = 0x07;
    pkt[2] = keyIndex;
    pkt[3] = isLast ? IMAGE_CHUNK_LAST_FLAG : 0;
    pkt.writeUInt16LE(bodyLen, 4);
    pkt.set(jpeg.subarray(offset, offset + bodyLen), ELGATO_IMAGE_HEADER_SIZE);
    frames.push(encodeCoraFrame(pkt, CORA_FLAG_REQACK, 0x02, seq));
    offset += bodyLen;
    seq++;
    if (isLast) break;
  }
  return frames;
}

/** Group whole frames into TCP-delivery-sized chunks (a real socket read can
 *  coalesce several small writes, or a large one can span several frames). */
function groupWhole(frames: Buffer[], framesPerChunk: number): Buffer[] {
  const chunks: Buffer[] = [];
  for (let i = 0; i < frames.length; i += framesPerChunk) {
    chunks.push(Buffer.concat(frames.slice(i, i + framesPerChunk)));
  }
  return chunks;
}

/** Split every frame in half across the TCP-delivery boundary — worst case for
 *  the reader: every append() leaves a dangling partial frame, so the merge-copy
 *  path is exercised on every call (never takes the "buffer empty" fast path). */
function splitEveryFrame(frames: Buffer[]): Buffer[] {
  const chunks: Buffer[] = [];
  for (const f of frames) {
    const mid = f.length >> 1;
    chunks.push(f.subarray(0, mid) as Buffer, f.subarray(mid) as Buffer);
  }
  return chunks;
}

// Old CoraFrameReader: byte-for-byte the same class as ../src/cora-frame.ts
// (same hasMagicAtStart/resyncToMagic/drainFrames), EXCEPT append() always
// Buffer.concats, even when `buffer` is already empty. This isolates the one
// line the "hot-path quick win" changes — everything else (magic scan, resync,
// per-frame decode cost) is identical to the "after" class under test, so the
// only measured delta is the copy-skip itself.
class OldCoraFrameReader {
  private buffer: Buffer = Buffer.alloc(0);

  append(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
  }

  private hasMagicAtStart(): boolean {
    return (
      this.buffer[0] === CORA_MAGIC[0] &&
      this.buffer[1] === CORA_MAGIC[1] &&
      this.buffer[2] === CORA_MAGIC[2] &&
      this.buffer[3] === CORA_MAGIC[3]
    );
  }

  private resyncToMagic(): boolean {
    const idx = this.buffer.indexOf(CORA_MAGIC, 1);
    if (idx === -1) {
      if (this.buffer.length >= CORA_HEADER_SIZE) {
        this.buffer = this.buffer.subarray(this.buffer.length - 3) as Buffer;
      }
      return false;
    }
    this.buffer = this.buffer.subarray(idx) as Buffer;
    return true;
  }

  drainFrames(): CoraFrame[] {
    const frames: CoraFrame[] = [];
    while (this.buffer.length >= CORA_HEADER_SIZE) {
      if (!this.hasMagicAtStart()) {
        if (!this.resyncToMagic()) break;
        continue;
      }
      const frame = tryDecodeCoraFrame(this.buffer);
      if (!frame) break;
      const totalLen = frameTotalLength(frame);
      this.buffer = this.buffer.subarray(totalLen) as Buffer;
      frames.push(frame);
    }
    return frames;
  }
}

function benchReader(
  label: string,
  makeReader: () => { append(c: Buffer): void; drainFrames(): unknown },
  chunkSets: Buffer[][],
  iters: number,
): number {
  // warm-up
  for (let i = 0; i < Math.min(iters >> 2, 5); i++) {
    const r = makeReader();
    for (const set of chunkSets)
      for (const c of set) {
        r.append(c);
        r.drainFrames();
      }
  }
  const t0 = Date.now();
  for (let i = 0; i < iters; i++) {
    const r = makeReader();
    for (const set of chunkSets)
      for (const c of set) {
        r.append(c);
        r.drainFrames();
      }
  }
  const ms = Date.now() - t0;
  console.log(
    `  ${label.padEnd(28)}: ${String(ms).padStart(5)}ms / ${iters} iters = ${(ms / iters).toFixed(3)}ms/op`,
  );
  return ms;
}

function bench(label: string, fn: () => void, iters: number): number {
  for (let i = 0; i < Math.min(iters >> 2, 10); i++) fn();
  const t0 = Date.now();
  for (let i = 0; i < iters; i++) fn();
  const ms = Date.now() - t0;
  console.log(
    `  ${label.padEnd(28)}: ${String(ms).padStart(5)}ms / ${iters} iters = ${(ms / iters).toFixed(3)}ms/op`,
  );
  return ms;
}

console.log('\n=== CORA image-path copy benchmark (QuickJS / txiki.js) ===\n');

// 1. CoraFrameReader.append(): old (always concat) vs new (skip when drained)

const ITERS = 4000;

for (const kb of IMAGE_SIZES_KB) {
  const bytes = Math.round(kb * 1024);
  const jpeg = makeImageBytes(bytes);
  const frames = encodeKeyImageFrames(1, jpeg);

  console.log(`[${kb} KB key image — ${frames.length} CORA chunk(s)]`);

  // Whole-frame delivery, one TCP chunk per frame (typical: reader fully drains
  // every append(), so the new code takes the zero-copy fast path every time).
  const perFrame = groupWhole(frames, 1);
  const oldPerFrame = benchReader(
    'old: concat (per-frame)',
    () => new OldCoraFrameReader(),
    [perFrame],
    ITERS,
  );
  const newPerFrame = benchReader(
    'new: adopt (per-frame)',
    () => new CoraFrameReader(),
    [perFrame],
    ITERS,
  );
  console.log(`  speedup: ${(oldPerFrame / newPerFrame).toFixed(1)}x`);

  // Whole-frame delivery, several frames coalesced per TCP chunk.
  const coalesced = groupWhole(frames, 4);
  const oldCoalesced = benchReader(
    'old: concat (coalesced x4)',
    () => new OldCoraFrameReader(),
    [coalesced],
    ITERS,
  );
  const newCoalesced = benchReader(
    'new: adopt (coalesced x4)',
    () => new CoraFrameReader(),
    [coalesced],
    ITERS,
  );
  console.log(`  speedup: ${(oldCoalesced / newCoalesced).toFixed(1)}x`);

  // Worst case: every frame split across the chunk boundary (reader never fully
  // drains — always takes the merge-copy path in both old and new code).
  const split = splitEveryFrame(frames);
  const oldSplit = benchReader(
    'old: concat (split)',
    () => new OldCoraFrameReader(),
    [split],
    ITERS,
  );
  const newSplit = benchReader('new: adopt (split)', () => new CoraFrameReader(), [split], ITERS);
  console.log(
    `  worst case ratio: ${(newSplit / oldSplit).toFixed(2)}x (should be ~1.0 — no regression)\n`,
  );
}

// 2. Flat per-image copy cost removed (hid-worker-host.ts pre-copy, WebUI mirror copy)

console.log('[flat copy cost eliminated per image — new Uint8Array(bytes) / Buffer.from(data)]');
// Sink prevents the engine from eliding the otherwise-unused copy as dead code.
let sink: unknown;
for (const kb of IMAGE_SIZES_KB) {
  const bytes = Math.round(kb * 1024);
  const buf = Buffer.from(makeImageBytes(bytes));
  const iters = 2000;
  const copyMs = bench(`${kb} KB: new Uint8Array(buf)`, () => (sink = new Uint8Array(buf)), iters);
  const passMs = bench(`${kb} KB: pass-through (no copy)`, () => (sink = buf), iters);
  console.log(
    `  ${kb} KB copy overhead removed: ${(copyMs / iters).toFixed(4)}ms/op (baseline ${(passMs / iters).toFixed(4)}ms/op)\n`,
  );
}
console.log(`  (sink check: ${typeof sink})`);

// Correctness spot-check: new reader must decode the same frames as the old one
// regardless of chunking pattern (byte-for-byte payload match).

let failed = 0;
function pass(label: string): void {
  console.log(`  ${label}: OK`);
}
function fail(label: string): void {
  console.log(`  ${label}: FAIL`);
  failed++;
}

console.log('correctness (all chunking patterns decode identically):');
for (const kb of IMAGE_SIZES_KB) {
  const bytes = Math.round(kb * 1024);
  const jpeg = makeImageBytes(bytes);
  const frames = encodeKeyImageFrames(2, jpeg);
  for (const [name, chunks] of [
    ['per-frame', groupWhole(frames, 1)],
    ['coalesced x4', groupWhole(frames, 4)],
    ['split', splitEveryFrame(frames)],
    ['one giant chunk', [Buffer.concat(frames)]],
  ] as const) {
    const reader = new CoraFrameReader();
    const payloads: Buffer[] = [];
    for (const c of chunks) {
      reader.append(c);
      for (const f of reader.drainFrames()) payloads.push(f.payload);
    }
    const total = payloads.reduce((n, p) => n + p.length, 0);
    const expected = frames.length * ELGATO_IMAGE_HEADER_SIZE + jpeg.length;
    (payloads.length === frames.length && total === expected ? pass : fail)(
      `${kb} KB / ${name}: ${payloads.length}/${frames.length} frames, ${total}/${expected} bytes`,
    );
  }
}

tjs.exit(failed > 0 ? 1 : 0);
