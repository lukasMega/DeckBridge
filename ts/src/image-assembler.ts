import {
  IMAGE_CHUNK_KEY_OFFSET,
  IMAGE_CHUNK_FLAG_OFFSET,
  IMAGE_CHUNK_LEN_OFFSET,
  IMAGE_CHUNK_LAST_FLAG,
  ELGATO_IMAGE_HEADER_SIZE,
  GEN1_IMAGE_HEADER_SIZE,
  GEN1_IMAGE_KEY_OFFSET,
  GEN1_IMAGE_LAST_OFFSET,
  MAX_IMAGE_ASSEMBLY_BYTES,
  MAX_IMAGE_ASSEMBLY_CHUNKS,
  PARTIAL_WINDOW_HEADER_SIZE,
  PARTIAL_WINDOW_X_OFFSET,
  PARTIAL_WINDOW_Y_OFFSET,
  PARTIAL_WINDOW_W_OFFSET,
  PARTIAL_WINDOW_H_OFFSET,
  PARTIAL_WINDOW_LAST_OFFSET,
  PARTIAL_WINDOW_SIZE_OFFSET,
} from './types.js';
import type { ImageEvent, TouchWindowRegion } from './types.js';
import { warn } from './logger.js';

export interface ImageAssembly {
  chunks: Buffer[];
  bytes: number;
}

const GEN2_LABEL = 'image assembly';
const GEN1_LABEL = 'gen1 image assembly';

// Malformed framing arrives at the peer's rate, and each warn() fans out to the
// console, the WebUI socket and a postMessage on the ACK-paced path. Warn once per
// `${label}:${reason}` per window (key space bounded by us, not the peer) and fold
// the rest into a count. The two cap warnings below self-limit, so are not throttled.
const MALFORMED_WARN_INTERVAL_MS = 5000;
const malformedWarnState = new Map<string, { last: number; suppressed: number }>();

/** Test-only: clear throttle state so each case observes a first-in-window warn. */
export function resetMalformedWarnThrottle(): void {
  malformedWarnState.clear();
}

/** Drop the in-flight assembly for `keyIndex` and report why, at most once per window.
 *  Callers return null themselves — a `null`-returning helper trips
 *  sonarjs/no-invariant-returns. */
function dropMalformed(
  pages: Map<number, ImageAssembly>,
  keyIndex: number,
  label: string,
  reason: string,
): void {
  pages.delete(keyIndex);
  const throttleKey = `${label}:${reason}`;
  const now = Date.now();
  const state = malformedWarnState.get(throttleKey);
  if (state && now - state.last < MALFORMED_WARN_INTERVAL_MS) {
    state.suppressed++;
    return;
  }
  const suppressed = state?.suppressed ?? 0;
  malformedWarnState.set(throttleKey, { last: now, suppressed: 0 });
  warn(
    'assembler',
    `key ${keyIndex}: ${label} dropped — ${reason}` +
      (suppressed > 0 ? ` (${suppressed} similar suppressed)` : ''),
  );
}

/** Append `chunk` to the per-key assembly, enforcing both assembly caps.
 *  On overflow: drops the key, warns naming the cap that tripped and its value
 *  (`label` distinguishes gen1/gen2 wording), and returns null. Otherwise pushes
 *  the chunk and returns the updated assembly. */
function accumulateChunk(
  pages: Map<number, ImageAssembly>,
  keyIndex: number,
  chunk: Buffer,
  label: string,
): ImageAssembly | null {
  const assembly = pages.get(keyIndex) ?? { chunks: [], bytes: 0 };
  if (assembly.bytes + chunk.length > MAX_IMAGE_ASSEMBLY_BYTES) {
    pages.delete(keyIndex);
    warn(
      'assembler',
      `key ${keyIndex}: ${label} exceeded ${MAX_IMAGE_ASSEMBLY_BYTES} bytes, dropping`,
    );
    return null;
  }
  // Empty chunks are not retained, so they cannot push the chunk count up.
  if (chunk.length > 0 && assembly.chunks.length >= MAX_IMAGE_ASSEMBLY_CHUNKS) {
    pages.delete(keyIndex);
    warn(
      'assembler',
      `key ${keyIndex}: ${label} exceeded ${MAX_IMAGE_ASSEMBLY_CHUNKS} chunks, dropping`,
    );
    return null;
  }
  if (chunk.length > 0) assembly.chunks.push(chunk);
  assembly.bytes += chunk.length;
  pages.set(keyIndex, assembly);
  return assembly;
}

export function assembleImageChunk(
  pages: Map<number, ImageAssembly>,
  pkt: Buffer,
): ImageEvent | null {
  // Shorter than the key byte itself: the packet names no key, so there is
  // nothing identifiable to drop. Bail before deriving keyIndex — reading past
  // the end would yield undefined and make the drop below a silent no-op.
  if (pkt.length <= IMAGE_CHUNK_KEY_OFFSET) return null;
  const keyIndex = pkt[IMAGE_CHUNK_KEY_OFFSET]!;
  if (pkt.length < ELGATO_IMAGE_HEADER_SIZE) {
    dropMalformed(pages, keyIndex, GEN2_LABEL, 'packet shorter than the 8-byte header');
    return null;
  }
  const isLast = pkt[IMAGE_CHUNK_FLAG_OFFSET] === IMAGE_CHUNK_LAST_FLAG;
  const bodyLength = pkt.readUInt16LE(IMAGE_CHUNK_LEN_OFFSET);
  if (bodyLength > pkt.length - ELGATO_IMAGE_HEADER_SIZE) {
    dropMalformed(pages, keyIndex, GEN2_LABEL, 'declared body length exceeds the packet');
    return null;
  }
  if (!isLast && bodyLength === 0) {
    dropMalformed(pages, keyIndex, GEN2_LABEL, 'empty non-final chunk');
    return null;
  }
  const chunk = Buffer.from(
    pkt.subarray(ELGATO_IMAGE_HEADER_SIZE, ELGATO_IMAGE_HEADER_SIZE + bodyLength),
  );

  const acc = accumulateChunk(pages, keyIndex, chunk, GEN2_LABEL);
  if (acc === null) return null;

  if (!isLast) return null;

  const data = Buffer.concat(acc.chunks, acc.bytes);
  pages.delete(keyIndex);
  return { keyIndex, data, format: 'jpeg' };
}

export function assembleGen1ImageChunk(
  pages: Map<number, ImageAssembly>,
  pkt: Buffer,
): ImageEvent | null {
  // Shorter than the key byte itself: the packet names no key, so there is
  // nothing identifiable to drop. Bail before deriving keyIndex — reading past
  // the end would yield undefined, making keyIndex NaN and the drop a no-op.
  if (pkt.length <= GEN1_IMAGE_KEY_OFFSET) return null;
  // gen1: key is 1-based at byte 5
  const keyIndex = pkt[GEN1_IMAGE_KEY_OFFSET]! - 1;
  if (pkt.length < GEN1_IMAGE_HEADER_SIZE) {
    dropMalformed(pages, keyIndex, GEN1_LABEL, 'packet shorter than the 16-byte header');
    return null;
  }
  const isLast = pkt[GEN1_IMAGE_LAST_OFFSET] === IMAGE_CHUNK_LAST_FLAG;
  if (!isLast && pkt.length === GEN1_IMAGE_HEADER_SIZE) {
    dropMalformed(pages, keyIndex, GEN1_LABEL, 'empty non-final chunk');
    return null;
  }

  // Slice full payload region (1008 bytes). Last packet has trailing zeros —
  // trimmed after assembly using BMP bfSize field (offset 2, LE uint32).
  const payload = Buffer.from(pkt.subarray(GEN1_IMAGE_HEADER_SIZE));

  const acc = accumulateChunk(pages, keyIndex, payload, GEN1_LABEL);
  if (acc === null) return null;
  if (!isLast) return null;

  pages.delete(keyIndex);
  const assembled = Buffer.concat(acc.chunks, acc.bytes);

  // BMP magic: 'B'=0x42 'M'=0x4D; bfSize at offset 2 (LE uint32).
  let data: Buffer;
  if (assembled.length >= 6 && assembled[0] === 0x42 && assembled[1] === 0x4d) {
    const bfSize = assembled.readUInt32LE(2);
    data = bfSize <= assembled.length ? Buffer.from(assembled.subarray(0, bfSize)) : assembled;
  } else {
    data = assembled; // malformed BMP — forward as-is, device will reject
  }

  return { keyIndex, data, format: 'bmp' };
}

/** In-flight Stream Deck + partial-window region (keyed by its rectangle). */
export interface PartialWindowAssembly extends ImageAssembly {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A completed partial-window region: its window rectangle + the assembled JPEG. */
export interface PartialWindowEvent extends TouchWindowRegion {
  data: Buffer;
}

/** Assemble a Stream Deck + partial-window (0x0C) chunk into one region JPEG. The
 *  16-byte header repeats the region rectangle on every chunk; chunks are keyed by
 *  that rectangle so interleaved regions cannot mix. Returns the region on the last
 *  chunk, null otherwise. */
export function assemblePartialWindowChunk(
  pages: Map<string, PartialWindowAssembly>,
  pkt: Buffer,
): PartialWindowEvent | null {
  if (pkt.length < PARTIAL_WINDOW_HEADER_SIZE) return null;
  const x = pkt.readUInt16LE(PARTIAL_WINDOW_X_OFFSET);
  const y = pkt.readUInt16LE(PARTIAL_WINDOW_Y_OFFSET);
  const w = pkt.readUInt16LE(PARTIAL_WINDOW_W_OFFSET);
  const h = pkt.readUInt16LE(PARTIAL_WINDOW_H_OFFSET);
  const isLast = pkt[PARTIAL_WINDOW_LAST_OFFSET] === IMAGE_CHUNK_LAST_FLAG;
  const bodyLength = pkt.readUInt16LE(PARTIAL_WINDOW_SIZE_OFFSET);
  if (bodyLength > pkt.length - PARTIAL_WINDOW_HEADER_SIZE) {
    warn('assembler', `partial window: declared body ${bodyLength} exceeds packet — dropped`);
    return null;
  }
  const chunk = Buffer.from(
    pkt.subarray(PARTIAL_WINDOW_HEADER_SIZE, PARTIAL_WINDOW_HEADER_SIZE + bodyLength),
  );

  const key = `${x}:${y}:${w}:${h}`;
  const acc = pages.get(key) ?? { chunks: [], bytes: 0, x, y, w, h };
  if (acc.bytes + chunk.length > MAX_IMAGE_ASSEMBLY_BYTES) {
    pages.delete(key);
    warn(
      'assembler',
      `partial window ${key}: exceeded ${MAX_IMAGE_ASSEMBLY_BYTES} bytes — dropped`,
    );
    return null;
  }
  if (chunk.length > 0 && acc.chunks.length >= MAX_IMAGE_ASSEMBLY_CHUNKS) {
    pages.delete(key);
    warn(
      'assembler',
      `partial window ${key}: exceeded ${MAX_IMAGE_ASSEMBLY_CHUNKS} chunks — dropped`,
    );
    return null;
  }
  if (chunk.length > 0) acc.chunks.push(chunk);
  acc.bytes += chunk.length;
  pages.set(key, acc);

  if (!isLast) return null;
  pages.delete(key);
  return { x, y, w, h, data: Buffer.concat(acc.chunks, acc.bytes) };
}
