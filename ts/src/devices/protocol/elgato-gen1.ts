/** gen1 HID protocol: Stream Deck Mini.
 *  Image: BMP (19254 bytes), 1024-byte packets, 16-byte header, 1-based key index.
 *  Input: report 0x01, button states at data[0..keyCount] (after stripping report ID). */

import { packChunks, parseButtons } from './framing.js';

const PACKET_SIZE = 1024;
const HEADER_SIZE = 16;

/** Split native BMP bytes into gen1 output report buffers (each 1024 bytes). */
export function gen1PackImage(keyIndex: number, bmpBytes: Uint8Array): Uint8Array[] {
  return packChunks(bmpBytes, PACKET_SIZE, HEADER_SIZE, (pkt, part, isLast) => {
    pkt[0] = 0x02;
    pkt[1] = 0x01;
    pkt[2] = part & 0xff; // partIndex (0-based, UInt8)
    pkt[3] = 0x00;
    pkt[4] = isLast ? 1 : 0;
    pkt[5] = keyIndex + 1; // 1-based key index
    // bytes 6-15: padding (zero)
  });
}

/** Parse gen1 input report into key states.
 *  data[0] = report ID 0x01; button states at data[1..1+keyCount]. */
export function gen1ParseInput(
  data: Uint8Array,
  keyCount: number,
): Array<{ keyIndex: number; pressed: boolean }> | null {
  if (data[0] !== 0x01) return null;
  // KEY_DATA_OFFSET = 1: data[1] is first key after stripping report ID
  return parseButtons(data, keyCount, 1);
}

/** gen1 brightness feature report (17 bytes). */
export function gen1BrightnessReport(pct: number): Uint8Array {
  const buf = new Uint8Array(17);
  buf[0] = 0x05;
  buf[1] = 0x55;
  buf[2] = 0xaa;
  buf[3] = 0xd1;
  buf[4] = 0x01;
  buf[5] = Math.max(0, Math.min(100, pct));
  return buf;
}

/** gen1 reset-to-logo feature report (17 bytes). */
export function gen1ResetReport(): Uint8Array {
  const buf = new Uint8Array(17);
  buf[0] = 0x0b;
  buf[1] = 0x63;
  return buf;
}
