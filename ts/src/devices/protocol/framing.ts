/** Shared HID framing helpers for the Elgato gen1/gen2 protocols. Both chunk an image
 *  into fixed-size output reports and parse button-state input reports the same way —
 *  only the header bytes, header size and report-ID validation differ. */

/** Split a payload into fixed-size packets, writing a per-protocol header into each
 *  (`writeHeader` fills bytes [0, headerSize)) and handing each to `write`. The
 *  `|| part === 0` guard emits one empty packet for an empty payload, as both protocols
 *  did before. `pkt` is caller-owned scratch reused for EVERY chunk, so `write` must
 *  consume it synchronously; its length is the packet size. */
export function writeChunks(
  payload: Uint8Array,
  pkt: Uint8Array,
  headerSize: number,
  writeHeader: (pkt: Uint8Array, part: number, isLast: boolean, bodyLen: number) => void,
  write: (pkt: Uint8Array) => void,
): void {
  const payloadSize = pkt.length - headerSize;
  let offset = 0;
  let part = 0;
  while (offset < payload.length || part === 0) {
    const chunk = payload.subarray(offset, offset + payloadSize);
    const isLast = offset + payloadSize >= payload.length;

    // Whole packet, not just the tail: the buffer is reused and writeHeader need not
    // cover all of [0, headerSize) (gen1 leaves 6..15 as expected-zero padding).
    pkt.fill(0);
    writeHeader(pkt, part, isLast, chunk.length);
    pkt.set(chunk, headerSize);

    write(pkt);
    offset += payloadSize;
    part++;
    if (isLast) break;
  }
}

/** Read `keyCount` button states starting at `keyDataOffset`. A byte is
 *  "pressed" when non-zero. Report-ID validation is done by the caller. */
export function parseButtons(
  data: Uint8Array,
  keyCount: number,
  keyDataOffset: number,
): Array<{ keyIndex: number; pressed: boolean }> {
  const result: Array<{ keyIndex: number; pressed: boolean }> = [];
  for (let i = 0; i < keyCount; i++) {
    result.push({ keyIndex: i, pressed: (data[keyDataOffset + i] ?? 0) !== 0 });
  }
  return result;
}

/** Build a fixed-size feature report from its non-zero prefix. */
export function featureReport(size: number, prefix: readonly number[]): Uint8Array {
  const report = new Uint8Array(size);
  report.set(prefix);
  return report;
}
