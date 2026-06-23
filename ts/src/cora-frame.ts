import { MAX_RECEIVE_BUFFER } from './types.js';
import { warn } from './logger.js';

export const CORA_MAGIC = Buffer.from([0x43, 0x93, 0x8a, 0x41]);
export const CORA_HEADER_SIZE = 16;

// CORA protocol flags (LE uint16 at offset 4)
export const CORA_FLAG_VERBATIM = 0x8000;
export const CORA_FLAG_REQACK = 0x4000;
export const CORA_FLAG_ACKNAK = 0x0200;
export const CORA_FLAG_RESULT = 0x0100;

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

export class CoraFrameReader {
  private buffer = Buffer.alloc(0);

  append(chunk: Buffer): void {
    if (this.buffer.length + chunk.length > MAX_RECEIVE_BUFFER) {
      const dropped = this.buffer.length + chunk.length - MAX_RECEIVE_BUFFER;
      warn(
        'cora',
        `receive buffer overflow: dropping ${dropped} oldest byte(s) (limit ${MAX_RECEIVE_BUFFER}) — possible desync`,
      );
      this.buffer = this.buffer.subarray(Math.max(0, dropped)) as Buffer;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
  }

  drainFrames(): CoraFrame[] {
    const frames: CoraFrame[] = [];
    while (this.buffer.length >= CORA_HEADER_SIZE) {
      if (
        this.buffer[0] !== CORA_MAGIC[0] ||
        this.buffer[1] !== CORA_MAGIC[1] ||
        this.buffer[2] !== CORA_MAGIC[2] ||
        this.buffer[3] !== CORA_MAGIC[3]
      ) {
        const idx = this.buffer.indexOf(CORA_MAGIC, 1);
        if (idx === -1) {
          if (this.buffer.length >= CORA_HEADER_SIZE) {
            this.buffer = this.buffer.subarray(this.buffer.length - 3) as Buffer;
          }
          break;
        }
        this.buffer = this.buffer.subarray(idx) as Buffer;
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
    return frames;
  }

  getBufferedLength(): number {
    return this.buffer.length;
  }
}
