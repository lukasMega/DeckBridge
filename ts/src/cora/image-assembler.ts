import { PLUS_TOUCH_WIDTH, PLUS_TOUCH_HEIGHT } from '../shared/types.js';
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
  MAX_TOTAL_ASSEMBLY_BYTES,
  ASSEMBLY_STALE_MS,
  PARTIAL_WINDOW_HEADER_SIZE,
  PARTIAL_WINDOW_X_OFFSET,
  PARTIAL_WINDOW_Y_OFFSET,
  PARTIAL_WINDOW_W_OFFSET,
  PARTIAL_WINDOW_H_OFFSET,
  PARTIAL_WINDOW_LAST_OFFSET,
  PARTIAL_WINDOW_SIZE_OFFSET,
} from './protocol.js';
import type { ImageEvent, TouchWindowRegion } from '../shared/types.js';
import { warn } from '../shared/logger.js';

export interface ImageAssembly {
  chunks: Buffer[];
  bytes: number;
  /** Set only while tracked by an AssemblyBudget. */
  owner?: Map<never, ImageAssembly>;
  key?: number | string;
  touchedAt?: number;
}

/** Aggregate byte budget over every in-flight assembly of one connection. The Set keeps
 *  least-recently-touched first (delete+add on each chunk), so eviction and stale expiry
 *  only look at the head — no per-chunk scan. */
export class AssemblyBudget {
  private readonly live = new Set<ImageAssembly>();
  private total = 0;
  private lastWarn = 0;

  constructor(
    private readonly maxBytes = MAX_TOTAL_ASSEMBLY_BYTES,
    private readonly staleMs = ASSEMBLY_STALE_MS,
  ) {}

  get bytes(): number {
    return this.total;
  }

  get count(): number {
    return this.live.size;
  }

  /** Forget everything; callers replace their maps. */
  clear(): void {
    this.live.clear();
    this.total = 0;
  }

  /** Account `delta` more bytes for `a`; evicts the oldest others to fit. False when `a`
   *  alone cannot fit (caller drops it). */
  charge(a: ImageAssembly, delta: number, now: number): boolean {
    if (!this.live.has(a)) this.expireStale(now);
    else this.live.delete(a);
    a.touchedAt = now;
    this.live.add(a);
    this.total += delta;
    while (this.total > this.maxBytes) {
      const oldest = this.live.values().next().value!;
      if (oldest === a) {
        this.total -= a.bytes + delta;
        this.live.delete(a);
        return false;
      }
      this.evict(oldest, 'aggregate byte budget');
    }
    return true;
  }

  release(a: ImageAssembly): void {
    if (this.live.delete(a)) this.total -= a.bytes;
  }

  private expireStale(now: number): void {
    for (const a of this.live) {
      if (now - (a.touchedAt ?? now) < this.staleMs) break;
      this.evict(a, 'stale');
    }
  }

  private evict(a: ImageAssembly, why: string): void {
    this.release(a);
    (a.owner as Map<number | string, ImageAssembly> | undefined)?.delete(a.key!);
    const now = Date.now();
    if (now - this.lastWarn < MALFORMED_WARN_INTERVAL_MS) return;
    this.lastWarn = now;
    warn('assembler', `key ${a.key}: incomplete image assembly dropped (${why})`);
  }
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

function discard<K extends number | string>(
  pages: Map<K, ImageAssembly>,
  key: K,
  budget?: AssemblyBudget,
): void {
  const a = pages.get(key);
  if (a && budget) budget.release(a);
  pages.delete(key);
}

/** Drop the in-flight assembly for `keyIndex` and report why, at most once per window.
 *  Callers return null themselves — a `null`-returning helper trips
 *  sonarjs/no-invariant-returns. */
function dropMalformed<K extends number | string>(
  pages: Map<K, ImageAssembly>,
  keyIndex: K,
  label: string,
  reason: string,
  budget?: AssemblyBudget,
): void {
  discard(pages, keyIndex, budget);
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

interface AccumulateOpts {
  label: string;
  budget?: AssemblyBudget;
  /** Max distinct in-flight keys; the oldest is evicted for a new one. */
  maxPages?: number;
}

/** Append `chunk` to the per-key assembly, enforcing the per-key, aggregate and
 *  key-count caps. On overflow: drops the key, warns naming the cap that tripped
 *  (`label` distinguishes gen1/gen2 wording), and returns null. Otherwise pushes
 *  the chunk and returns the updated assembly. `chunk` is retained by reference. */
function accumulateChunk<K extends number | string>(
  pages: Map<K, ImageAssembly>,
  keyIndex: K,
  chunk: Buffer,
  { label, budget, maxPages }: AccumulateOpts,
): ImageAssembly | null {
  let assembly = pages.get(keyIndex);
  if (!assembly) {
    if (maxPages !== undefined && pages.size >= maxPages) {
      // Map iteration is insertion order: the first key is the oldest in-flight one.
      discard(pages, pages.keys().next().value!, budget);
    }
    assembly = { chunks: [], bytes: 0, owner: pages as Map<never, ImageAssembly>, key: keyIndex };
  }
  if (assembly.bytes + chunk.length > MAX_IMAGE_ASSEMBLY_BYTES) {
    discard(pages, keyIndex, budget);
    warn(
      'assembler',
      `key ${keyIndex}: ${label} exceeded ${MAX_IMAGE_ASSEMBLY_BYTES} bytes, dropping`,
    );
    return null;
  }
  // Empty chunks are not retained, so they cannot push the chunk count up.
  if (chunk.length > 0 && assembly.chunks.length >= MAX_IMAGE_ASSEMBLY_CHUNKS) {
    discard(pages, keyIndex, budget);
    warn(
      'assembler',
      `key ${keyIndex}: ${label} exceeded ${MAX_IMAGE_ASSEMBLY_CHUNKS} chunks, dropping`,
    );
    return null;
  }
  if (budget && !budget.charge(assembly, chunk.length, Date.now())) {
    pages.delete(keyIndex);
    warn('assembler', `key ${keyIndex}: ${label} exceeded the aggregate byte budget, dropping`);
    return null;
  }
  if (chunk.length > 0) assembly.chunks.push(chunk);
  assembly.bytes += chunk.length;
  pages.set(keyIndex, assembly);
  return assembly;
}

/** One copy out of the assembly: a single chunk is copied (so the result does not pin
 *  the wire packet), several are concatenated. `limit` truncates. */
function consolidate(acc: ImageAssembly, limit = acc.bytes): Buffer {
  if (acc.chunks.length === 1) return Buffer.from(acc.chunks[0]!.subarray(0, limit));
  return Buffer.concat(acc.chunks, limit);
}

/** `pkt` is retained by reference until the image completes: the caller hands over
 *  ownership (CORA frame payloads are already private copies). */
export function assembleImageChunk(
  pages: Map<number, ImageAssembly>,
  pkt: Buffer,
  budget?: AssemblyBudget,
  maxPages?: number,
): ImageEvent | null {
  // Shorter than the key byte itself: the packet names no key, so there is
  // nothing identifiable to drop. Bail before deriving keyIndex — reading past
  // the end would yield undefined and make the drop below a silent no-op.
  if (pkt.length <= IMAGE_CHUNK_KEY_OFFSET) return null;
  const keyIndex = pkt[IMAGE_CHUNK_KEY_OFFSET]!;
  if (pkt.length < ELGATO_IMAGE_HEADER_SIZE) {
    dropMalformed(pages, keyIndex, GEN2_LABEL, 'packet shorter than the 8-byte header', budget);
    return null;
  }
  const isLast = pkt[IMAGE_CHUNK_FLAG_OFFSET] === IMAGE_CHUNK_LAST_FLAG;
  const bodyLength = pkt.readUInt16LE(IMAGE_CHUNK_LEN_OFFSET);
  if (bodyLength > pkt.length - ELGATO_IMAGE_HEADER_SIZE) {
    dropMalformed(pages, keyIndex, GEN2_LABEL, 'declared body length exceeds the packet', budget);
    return null;
  }
  if (!isLast && bodyLength === 0) {
    dropMalformed(pages, keyIndex, GEN2_LABEL, 'empty non-final chunk', budget);
    return null;
  }
  const chunk = pkt.subarray(ELGATO_IMAGE_HEADER_SIZE, ELGATO_IMAGE_HEADER_SIZE + bodyLength);

  const acc = accumulateChunk(pages, keyIndex, chunk as Buffer, {
    label: GEN2_LABEL,
    budget,
    maxPages,
  });
  if (acc === null) return null;

  if (!isLast) return null;

  const data = consolidate(acc);
  discard(pages, keyIndex, budget);
  return { keyIndex, data, format: 'jpeg' };
}

export function assembleGen1ImageChunk(
  pages: Map<number, ImageAssembly>,
  pkt: Buffer,
  budget?: AssemblyBudget,
): ImageEvent | null {
  // Shorter than the key byte itself: the packet names no key, so there is
  // nothing identifiable to drop. Bail before deriving keyIndex — reading past
  // the end would yield undefined, making keyIndex NaN and the drop a no-op.
  if (pkt.length <= GEN1_IMAGE_KEY_OFFSET) return null;
  // gen1: key is 1-based at byte 5
  const keyIndex = pkt[GEN1_IMAGE_KEY_OFFSET]! - 1;
  if (pkt.length < GEN1_IMAGE_HEADER_SIZE) {
    dropMalformed(pages, keyIndex, GEN1_LABEL, 'packet shorter than the 16-byte header', budget);
    return null;
  }
  const isLast = pkt[GEN1_IMAGE_LAST_OFFSET] === IMAGE_CHUNK_LAST_FLAG;
  if (!isLast && pkt.length === GEN1_IMAGE_HEADER_SIZE) {
    dropMalformed(pages, keyIndex, GEN1_LABEL, 'empty non-final chunk', budget);
    return null;
  }

  // Slice full payload region (1008 bytes). Last packet has trailing zeros —
  // trimmed after assembly using BMP bfSize field (offset 2, LE uint32).
  const payload = pkt.subarray(GEN1_IMAGE_HEADER_SIZE) as Buffer;

  const acc = accumulateChunk(pages, keyIndex, payload, { label: GEN1_LABEL, budget });
  if (acc === null) return null;
  if (!isLast) return null;

  discard(pages, keyIndex, budget);

  // BMP magic: 'B'=0x42 'M'=0x4D; bfSize at offset 2 (LE uint32). The first chunk holds
  // the header, so the trim is applied during the single consolidating copy.
  const first = acc.chunks[0];
  let limit = acc.bytes; // malformed BMP — forward as-is, device will reject
  if (first && first.length >= 6 && first[0] === 0x42 && first[1] === 0x4d) {
    const bfSize = first.readUInt32LE(2);
    if (bfSize <= acc.bytes) limit = bfSize;
  }

  return { keyIndex, data: consolidate(acc, limit), format: 'bmp' };
}

const PARTIAL_WINDOW_LABEL = 'partial window assembly';
/** In-flight partial-window regions kept at once. The key comes off the wire, so
 *  without a cap a peer that never sends a last chunk grows the map without bound. */
export const MAX_PARTIAL_WINDOW_ASSEMBLIES = 8;

/** A completed partial-window region: its window rectangle + the assembled JPEG. */
export interface PartialWindowEvent extends TouchWindowRegion {
  data: Buffer;
}

/** Assemble a Stream Deck + partial-window (0x0C) chunk into one region JPEG. The
 *  16-byte header repeats the region rectangle on every chunk; chunks are keyed by
 *  that rectangle so interleaved regions cannot mix. Returns the region on the last
 *  chunk, null otherwise. */
export function assemblePartialWindowChunk(
  pages: Map<string, ImageAssembly>,
  pkt: Buffer,
  budget?: AssemblyBudget,
): PartialWindowEvent | null {
  if (pkt.length < PARTIAL_WINDOW_HEADER_SIZE) return null;
  const x = pkt.readUInt16LE(PARTIAL_WINDOW_X_OFFSET);
  const y = pkt.readUInt16LE(PARTIAL_WINDOW_Y_OFFSET);
  const w = pkt.readUInt16LE(PARTIAL_WINDOW_W_OFFSET);
  const h = pkt.readUInt16LE(PARTIAL_WINDOW_H_OFFSET);
  const key = `${x}:${y}:${w}:${h}`;
  if (w === 0 || h === 0 || x + w > PLUS_TOUCH_WIDTH || y + h > PLUS_TOUCH_HEIGHT) {
    dropMalformed(pages, key, PARTIAL_WINDOW_LABEL, 'region outside the 800×100 window', budget);
    return null;
  }
  const isLast = pkt[PARTIAL_WINDOW_LAST_OFFSET] === IMAGE_CHUNK_LAST_FLAG;
  const bodyLength = pkt.readUInt16LE(PARTIAL_WINDOW_SIZE_OFFSET);
  if (bodyLength > pkt.length - PARTIAL_WINDOW_HEADER_SIZE) {
    dropMalformed(
      pages,
      key,
      PARTIAL_WINDOW_LABEL,
      'declared body length exceeds the packet',
      budget,
    );
    return null;
  }
  const chunk = pkt.subarray(
    PARTIAL_WINDOW_HEADER_SIZE,
    PARTIAL_WINDOW_HEADER_SIZE + bodyLength,
  ) as Buffer;
  const acc = accumulateChunk(pages, key, chunk, {
    label: PARTIAL_WINDOW_LABEL,
    budget,
    maxPages: MAX_PARTIAL_WINDOW_ASSEMBLIES,
  });
  if (!acc || !isLast) return null;
  const data = consolidate(acc);
  discard(pages, key, budget);
  return { x, y, w, h, data };
}
