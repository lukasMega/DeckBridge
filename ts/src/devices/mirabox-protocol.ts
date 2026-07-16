import { BAT_PADDING_BYTES, LIG_PADDING_BYTES, CLE_PADDING_BYTES } from '../types.js';

export const CRT = [0x43, 0x52, 0x54, 0x00, 0x00];
export const CMD_DIS = [0x44, 0x49, 0x53];
export const CMD_HAN = [0x48, 0x41, 0x4e];
export const CMD_STP = [0x53, 0x54, 0x50];
export const CMD_CONNECT = [0x43, 0x4f, 0x4e, 0x4e, 0x45, 0x43, 0x54];
export const ACK = [0x41, 0x43, 0x4b];

// Maps a CRT command tag to a human-readable describer; `b(i)` reads packet byte i.
// Commands not listed here (e.g. CONNECT) fall through to default handling.
export const CRT_DESCRIBERS: Record<string, (b: (i: number) => number) => string> = {
  DIS: () => 'CRT DIS',
  LIG: (b) => `CRT LIG brightness=${b(10)}`,
  CLE: (b) =>
    b(10) === 0x44 && b(11) === 0x43 ? 'CRT CLE-DC (disconnect)' : `CRT CLE keyId=${b(11)}`,
  BAT: (b) => `CRT BAT jpegLen=${(b(10) << 8) | b(11)} keyId=${b(12)}`,
  STP: () => 'CRT STP',
  HAN: () => 'CRT HAN',
};

// hidapi prepends the report-id byte to reads when reportId != 0, shifting offsets by 1.
export function parseAckReport(
  data: Buffer,
  reportId: number,
): { keyIndex: number; stateByte: number } | null {
  const off = reportId !== 0 ? 1 : 0;
  if (data[off] !== ACK[0] || data[off + 1] !== ACK[1] || data[off + 2] !== ACK[2]) return null;
  return { keyIndex: data[9 + off] ?? 0, stateByte: data[10 + off] ?? 0 };
}

function zeroPad(len: number): number[] {
  return Array.from({ length: len }, () => 0);
}

export function buildCrt(cmd: number[], extra: number[] = [], pktSize = 1024): Buffer {
  const buf = Buffer.alloc(pktSize, 0);
  let off = 0;
  for (const b of CRT) buf[off++] = b;
  for (const b of cmd) buf[off++] = b;
  for (const b of extra) buf[off++] = b;
  return buf;
}

export function buildBat(jpegLen: number, keyId: number, pktSize = 1024): Buffer {
  return buildCrt(
    [0x42, 0x41, 0x54],
    [...zeroPad(BAT_PADDING_BYTES), (jpegLen >> 8) & 0xff, jpegLen & 0xff, keyId],
    pktSize,
  );
}

/** Wire-encode an image for firmware that drops the last byte of every full
 *  pktSize chunk (K1 Pro): insert one sacrificial 0x00 after every
 *  (pktSize - 1) payload bytes, so no full chunk ever ends in payload and the
 *  device's drop reconstructs the original byte stream exactly. */
export function padChunkBoundaries(data: Uint8Array, pktSize = 1024): Buffer {
  const payload = pktSize - 1;
  if (data.length < payload) return Buffer.from(data);
  const groups = Math.floor(data.length / payload);
  const out = Buffer.alloc(data.length + groups);
  for (let g = 0; g < groups; g++) {
    out.set(data.subarray(g * payload, (g + 1) * payload), g * pktSize);
    // out[g * pktSize + payload] is already 0x00 — the sacrificial byte
  }
  out.set(data.subarray(groups * payload), groups * pktSize);
  return out;
}

export function buildLig(brightness: number, pktSize = 1024): Buffer {
  return buildCrt([0x4c, 0x49, 0x47], [...zeroPad(LIG_PADDING_BYTES), brightness], pktSize);
}

export function buildCle(keyId: number, pktSize = 1024): Buffer {
  return buildCrt([0x43, 0x4c, 0x45], [...zeroPad(CLE_PADDING_BYTES), keyId], pktSize);
}

// CLE carrying the "DC" (disconnect) marker at bytes 10–11 ('D','C') — tells the
// device the host is detaching so it returns to idle instead of holding stale
// images. Distinct from buildCle(keyId), which clears a single key.
export function buildCleDc(pktSize = 1024): Buffer {
  return buildCrt([0x43, 0x4c, 0x45], [...zeroPad(CLE_PADDING_BYTES - 1), 0x44, 0x43], pktSize);
}
