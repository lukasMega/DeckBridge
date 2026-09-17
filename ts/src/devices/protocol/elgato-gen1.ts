/** gen1 HID protocol: Stream Deck Mini.
 *  Image: BMP (19254 bytes), 1024-byte packets, 16-byte header, 1-based key index.
 *  Input: report 0x01, button states at data[0..keyCount] (after stripping report ID). */

import { featureReport, writeChunks, parseButtons } from './framing.js';

const HEADER_SIZE = 16;

/** Split native BMP bytes into gen1 output reports (each 1024 bytes), handing each
 *  to `write`. `scratch` is reused for every chunk — see writeChunks. */
export function gen1WriteImage(
  keyIndex: number,
  bmpBytes: Uint8Array,
  scratch: Uint8Array,
  write: (pkt: Uint8Array) => void,
): void {
  writeChunks(
    bmpBytes,
    scratch,
    HEADER_SIZE,
    (pkt, part, isLast) => {
      pkt[0] = 0x02;
      pkt[1] = 0x01;
      pkt[2] = part & 0xff; // partIndex (0-based, UInt8)
      pkt[3] = 0x00;
      pkt[4] = isLast ? 1 : 0;
      pkt[5] = keyIndex + 1; // 1-based key index
      // bytes 6-15: padding (zero)
    },
    write,
  );
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
  return featureReport(17, [0x05, 0x55, 0xaa, 0xd1, 0x01, Math.max(0, Math.min(100, pct))]);
}

/** gen1 reset-to-logo feature report (17 bytes). */
export function gen1ResetReport(): Uint8Array {
  return featureReport(17, [0x0b, 0x63]);
}

/** All-black key image: a zeroed BMP of the key's size (all zeros → black pixels). */
export function gen1BlankImage(keyWidth: number, keyHeight: number): Uint8Array {
  return new Uint8Array(54 + keyWidth * keyHeight * 3);
}

/** serial/firmware feature reports: plain ASCII at offset 5, runs to end of report. */
export const GEN1_INFO_REPORTS = {
  serial: { reportId: 0x03, offset: 5, lengthPrefixed: false },
  firmware: { reportId: 0x04, offset: 5, lengthPrefixed: false },
};
