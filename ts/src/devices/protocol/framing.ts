/** Shared HID framing helpers for the Elgato gen1/gen2 protocols.
 *  Both protocols chunk an image into fixed-size output reports and parse
 *  button-state input reports the same way — only the header bytes,
 *  header size, and report-ID validation differ. These two helpers hold the
 *  common loops; each protocol supplies the tiny per-protocol differences. */

/** Split a payload into fixed-size packets, writing a per-protocol header into
 *  each. The `|| part === 0` guard emits one (empty-payload) packet even when
 *  `payload` is empty, matching both protocols' original behavior.
 *  `writeHeader` fills bytes [0, headerSize) of each packet. */
export function packChunks(
  payload: Uint8Array,
  packetSize: number,
  headerSize: number,
  writeHeader: (pkt: Uint8Array, part: number, isLast: boolean, bodyLen: number) => void,
): Uint8Array[] {
  const payloadSize = packetSize - headerSize;
  const packets: Uint8Array[] = [];
  let offset = 0;
  let part = 0;
  while (offset < payload.length || part === 0) {
    const chunk = payload.subarray(offset, offset + payloadSize);
    const isLast = offset + payloadSize >= payload.length;

    const pkt = new Uint8Array(packetSize);
    writeHeader(pkt, part, isLast, chunk.length);
    pkt.set(chunk, headerSize);

    packets.push(pkt);
    offset += payloadSize;
    part++;
    if (isLast) break;
  }
  return packets;
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
