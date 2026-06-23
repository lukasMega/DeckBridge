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
} from './types.js';
import type { ImageEvent } from './types.js';
import { warn } from './logger.js';

function accumulatedBytes(pageList: Buffer[]): number {
  let total = 0;
  for (const page of pageList) total += page.length;
  return total;
}

/** Append `chunk` to the per-key page list, enforcing the assembly cap.
 *  On overflow: drops the key, warns (`label` distinguishes gen1/gen2 wording),
 *  and returns null. Otherwise pushes the chunk and returns the updated list. */
function accumulateChunk(
  pages: Map<number, Buffer[]>,
  keyIndex: number,
  chunk: Buffer,
  label: string,
): { pageList: Buffer[] } | null {
  const pageList = pages.get(keyIndex) ?? [];
  if (accumulatedBytes(pageList) + chunk.length > MAX_IMAGE_ASSEMBLY_BYTES) {
    pages.delete(keyIndex);
    warn(
      'assembler',
      `key ${keyIndex}: ${label} exceeded ${MAX_IMAGE_ASSEMBLY_BYTES} bytes, dropping`,
    );
    return null;
  }
  pageList.push(chunk);
  pages.set(keyIndex, pageList);
  return { pageList };
}

export function assembleImageChunk(pages: Map<number, Buffer[]>, pkt: Buffer): ImageEvent | null {
  const keyIndex = pkt[IMAGE_CHUNK_KEY_OFFSET]!;
  const isLast = pkt[IMAGE_CHUNK_FLAG_OFFSET] === IMAGE_CHUNK_LAST_FLAG;
  const bodyLength = pkt.readUInt16LE(IMAGE_CHUNK_LEN_OFFSET);
  const chunk = Buffer.from(
    pkt.subarray(ELGATO_IMAGE_HEADER_SIZE, ELGATO_IMAGE_HEADER_SIZE + bodyLength),
  );

  const acc = accumulateChunk(pages, keyIndex, chunk, 'image assembly');
  if (acc === null) return null;

  if (!isLast) return null;

  const data = Buffer.concat(acc.pageList);
  pages.delete(keyIndex);
  return { keyIndex, data, format: 'jpeg' };
}

export function assembleGen1ImageChunk(
  pages: Map<number, Buffer[]>,
  pkt: Buffer,
): ImageEvent | null {
  // gen1: key is 1-based at byte 5
  const keyIndex = pkt[GEN1_IMAGE_KEY_OFFSET]! - 1;
  const isLast = pkt[GEN1_IMAGE_LAST_OFFSET] === IMAGE_CHUNK_LAST_FLAG;

  // Slice full payload region (1008 bytes). Last packet has trailing zeros —
  // trimmed after assembly using BMP bfSize field (offset 2, LE uint32).
  const payload = Buffer.from(pkt.subarray(GEN1_IMAGE_HEADER_SIZE));

  const acc = accumulateChunk(pages, keyIndex, payload, 'gen1 image assembly');
  if (acc === null) return null;
  if (!isLast) return null;

  pages.delete(keyIndex);
  const assembled = Buffer.concat(acc.pageList);

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
