/** gen2 HID protocol: Stream Deck MK.2 / Classic / XL.
 *  Image: JPEG, 1024-byte packets, 8-byte header.
 *  Input: report 0x01, input-type byte 0x00, button states at data[3+i]. */

import { packChunks, parseButtons } from './framing.js';

const PACKET_SIZE = 1024;
const HEADER_SIZE = 8;

/** Split native JPEG bytes into gen2 output report buffers (each 1024 bytes). */
export function gen2PackImage(keyIndex: number, jpegBytes: Uint8Array): Uint8Array[] {
  return packChunks(jpegBytes, PACKET_SIZE, HEADER_SIZE, (pkt, part, isLast, bodyLen) => {
    pkt[0] = 0x02;
    pkt[1] = 0x07;
    pkt[2] = keyIndex;
    pkt[3] = isLast ? 1 : 0;
    pkt[4] = bodyLen & 0xff;
    pkt[5] = (bodyLen >> 8) & 0xff;
    pkt[6] = part & 0xff;
    pkt[7] = (part >> 8) & 0xff;
  });
}

/** Parse gen2 input report into key states.
 *  Returns array of {keyIndex, pressed} for any changed state or null if not a button report. */
export function gen2ParseInput(
  data: Uint8Array,
  keyCount: number,
): Array<{ keyIndex: number; pressed: boolean }> | null {
  // Numbered report: data[0] is the report ID (0x01).
  if (data[0] !== 0x01) return null;
  // data[1] = input type (0x00 = button)
  if (data[1] !== 0x00) return null;
  // Button states at data[3..3+keyCount]
  return parseButtons(data, keyCount, 3);
}

/** gen2 brightness feature report (32 bytes). */
export function gen2BrightnessReport(pct: number): Uint8Array {
  const buf = new Uint8Array(32);
  buf[0] = 0x03;
  buf[1] = 0x08;
  buf[2] = Math.max(0, Math.min(100, pct));
  return buf;
}

/** gen2 reset-to-logo feature report (32 bytes). */
export function gen2ResetReport(): Uint8Array {
  const buf = new Uint8Array(32);
  buf[0] = 0x03;
  buf[1] = 0x02;
  return buf;
}
