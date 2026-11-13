import { MAX_RECEIVE_BUFFER } from './protocol.js';
import { warn } from '../shared/logger.js';

export const CORA_MAGIC = Buffer.from([0x43, 0x93, 0x8a, 0x41]);
export const CORA_HEADER_SIZE = 16;

// CORA protocol flags (LE uint16 at offset 4)
export const CORA_FLAG_VERBATIM = 0x8000;
export const CORA_FLAG_REQACK = 0x4000;
export const CORA_FLAG_ACKNAK = 0x0200;
export const CORA_FLAG_RESULT = 0x0100;

/** Flags on every verbatim GET_REPORT / probe reply the child server sends. */
export const CORA_VERBATIM_RESULT = CORA_FLAG_RESULT | CORA_FLAG_VERBATIM;

export function coraFlagString(flags: number): string {
  const parts: string[] = [];
  if (flags & CORA_FLAG_VERBATIM) parts.push('VERB');
  if (flags & CORA_FLAG_REQACK) parts.push('REQACK');
  if (flags & CORA_FLAG_ACKNAK) parts.push('ACKNAK');
  if (flags & CORA_FLAG_RESULT) parts.push('RESULT');
  return parts.join('|') || '0';
}

export interface CoraFrame {
  flags: number;
  hidOp: number;
  messageId: number;
  payload: Buffer;
}

export function encodeCoraFrame(
  payload: Buffer,
  flags: number,
  hidOp: number,
  messageId: number,
): Buffer {
  const header = Buffer.alloc(CORA_HEADER_SIZE);
  CORA_MAGIC.copy(header, 0);
  header.writeUInt16LE(flags, 4);
  header.writeUInt8(hidOp, 6);
  header.writeUInt32LE(messageId, 8);
  header.writeUInt32LE(payload.length, 12);
  return Buffer.concat([header, payload]);
}

export function tryDecodeCoraFrame(buf: Buffer): CoraFrame | null {
  if (buf.length < CORA_HEADER_SIZE) return null;
  if (
    buf[0] !== CORA_MAGIC[0] ||
    buf[1] !== CORA_MAGIC[1] ||
    buf[2] !== CORA_MAGIC[2] ||
    buf[3] !== CORA_MAGIC[3]
  ) {
    return null;
  }
  const payloadLength = buf.readUInt32LE(12);
  if (buf.length < CORA_HEADER_SIZE + payloadLength) return null;
  return {
    flags: buf.readUInt16LE(4),
    hidOp: buf[6]!,
    messageId: buf.readUInt32LE(8),
    payload: Buffer.from(buf.subarray(CORA_HEADER_SIZE, CORA_HEADER_SIZE + payloadLength)),
  };
}

export function frameTotalLength(frame: CoraFrame): number {
  return CORA_HEADER_SIZE + frame.payload.length;
}

const EMPTY = Buffer.alloc(0);
/** Retained views over a larger backing store are copied out above this slack. */
const COMPACT_MIN_BACKING = 4096;

export class CoraFrameReader {
  private buffer: Buffer = EMPTY;

  append(chunk: Buffer): void {
    const total = this.buffer.length + chunk.length;
    if (total > MAX_RECEIVE_BUFFER) {
      const dropped = total - MAX_RECEIVE_BUFFER;
      warn(
        'cora',
        `receive buffer overflow: dropping ${dropped} oldest byte(s) (limit ${MAX_RECEIVE_BUFFER}) — possible desync`,
      );
      // The cap applies to existing + incoming, so an oversized chunk is cut too.
      if (dropped >= this.buffer.length) {
        chunk = chunk.subarray(dropped - this.buffer.length) as Buffer;
        this.buffer = EMPTY;
      } else {
        this.buffer = this.buffer.subarray(dropped) as Buffer;
      }
    }
    // Steady state: drainFrames() below fully drains every complete frame each
    // time, so `buffer` is usually empty when the next chunk lands — adopt it
    // directly instead of concat-copying it onto nothing. `chunk` is a fresh,
    // exclusively-owned per-read buffer (tcp.ts wraps it, never reused by txiki),
    // so holding onto it here is safe. Only merge-copy when a partial frame or
    // split magic is still pending from last time.
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    this.compact();
  }

  /** Release the backing store of a drained or mostly-consumed view. */
  private compact(): void {
    const len = this.buffer.length;
    if (len === 0) {
      this.buffer = EMPTY;
      return;
    }
    const backing = this.buffer.buffer.byteLength;
    if (backing > COMPACT_MIN_BACKING && backing > 2 * len) this.buffer = Buffer.from(this.buffer);
  }

  private hasMagicAtStart(): boolean {
    return (
      this.buffer[0] === CORA_MAGIC[0] &&
      this.buffer[1] === CORA_MAGIC[1] &&
      this.buffer[2] === CORA_MAGIC[2] &&
      this.buffer[3] === CORA_MAGIC[3]
    );
  }

  /** Skip ahead to the next magic. false = none left; keep only the trailing
   *  bytes that could still be a split magic and stop draining. */
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
      const declaredLen = this.buffer.readUInt32LE(12);
      if (declaredLen > MAX_RECEIVE_BUFFER - CORA_HEADER_SIZE) {
        warn(
          'cora',
          `frame declares payloadLength ${declaredLen} > buffer cap — skipping magic to resync`,
        );
        this.buffer = this.buffer.subarray(CORA_HEADER_SIZE) as Buffer;
        continue;
      }
      const frame = tryDecodeCoraFrame(this.buffer);
      if (!frame) break;
      const totalLen = frameTotalLength(frame);
      this.buffer = this.buffer.subarray(totalLen) as Buffer;
      frames.push(frame);
    }
    this.compact();
    return frames;
  }

  getBufferedLength(): number {
    return this.buffer.length;
  }

  /** Bytes of backing memory pinned by the buffered view (diagnostics/tests). */
  retainedBytes(): number {
    return this.buffer.buffer.byteLength;
  }
}
