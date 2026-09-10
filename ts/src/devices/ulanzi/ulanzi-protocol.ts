/** Ulanzi Stream Controller D200 wire protocol — pure, no I/O, no state.
 *  Mirrors devices/mirabox-protocol.ts in role, but this is a PAGE protocol:
 *  the unit of transfer is a whole-grid ZIP archive, not a single key image.
 *
 *  Every packet, both directions, is exactly PACKET_SIZE bytes. hidapi prepends
 *  the report-id byte on WRITES (the driver does that, as MiraboxDriver does);
 *  the D200's interface-0 report descriptor is UNNUMBERED, so reads come back
 *  with the magic at offset 0 and no report-id shift.
 *
 *    off  size  field
 *     0     2   magic 7c 7c
 *     2     2   command   u16 BIG-endian
 *     4     4   length    u32 LITTLE-endian  (TOTAL payload length, not this packet's)
 *     8  1016   payload   (zero-padded)
 *
 *  Multi-packet payloads (the page opcodes only): packet 0 carries the header
 *  plus the first 1016 bytes; packets 1..n are RAW 1024-byte chunks with NO
 *  header, the last one zero-padded.
 *
 *  NOT HARDWARE-TESTED. Constants come from the MIT-licensed reference
 *  implementations catalogued in .claude/plans/2026-09-10_ulanzi-d200-support.md
 *  and docs/references.md. */

export const MAGIC = [0x7c, 0x7c] as const;
export const PACKET_SIZE = 1024;
export const HEADER_SIZE = 8;
/** Payload bytes that fit alongside the header in packet 0. */
export const FIRST_CHUNK_DATA = PACKET_SIZE - HEADER_SIZE; // 1016

/** Opcodes we send or expect. Deliberately partial: the firmware also answers to
 *  0x0004 (kills the display app until replug), 0x00fe (rewrites the serial into
 *  secure flash, unauthenticated) and 0x00ff (switches USB into ADB mode). Those
 *  are NOT defined here on purpose, so no typo can reach them. */
export const CMD = {
  SET_BUTTONS: 0x0001, // page ZIP — replaces the whole grid
  SMALL_WINDOW: 0x0006, // ASCII info-window fields; doubles as our keepalive
  BRIGHTNESS: 0x000a, // ASCII "0".."100" (the firmware strtol()s it)
  LABEL_STYLE: 0x000b, // JSON font/label defaults
  PARTIAL_UPDATE: 0x000d, // page ZIP — merges into the current grid
  LOCK: 0x000f,
  UNLOCK: 0x0010,
  IN_BUTTON: 0x0101,
  IN_HEARTBEAT: 0x0103, // ~1 Hz, zeros
  IN_ZIP_ACK: 0x010b, // zeros; not flow control (nobody gates on it)
  IN_DEVICE_INFO: 0x0303, // JSON: SerialNumber / Dversion / DeviceType / HardwareVersion
} as const;

/** Input-report byte[8] (payload offset 0): which family of control fired. The
 *  wide info window reports presses too, under its own category. */
const INPUT_CATEGORY_WIDE = 0x00;

/** Font/label defaults written onto every manifest entry (CMD.LABEL_STYLE uses
 *  the same shape). DeckBridge renders its own labels into the key image, so the
 *  only job here is to keep the firmware from drawing a second one over ours —
 *  hence ShowTitle: false. */
export interface FontStyle {
  Align: string;
  Color: string;
  FontName: string;
  ShowTitle: boolean;
  Size: number;
  Weight: number;
}

export const DEFAULT_FONT: FontStyle = {
  Align: 'center',
  Color: '#FFFFFF',
  FontName: 'Regular',
  ShowTitle: false,
  Size: 12,
  Weight: 400,
};

export interface SmallWindowFields {
  /** Firmware render mode: 0 stats, 1 dial, 2 background image, 200–203 digital. */
  mode: number;
  cpu?: number;
  mem?: number;
  /** "HH:MM:SS"; omitted → empty field (the firmware falls back to its own clock). */
  time?: string;
  gpu?: number;
  /** "12H" or "24H". */
  hourFormat?: string;
  suffix?: string;
}

export type IncomingPacket =
  | { kind: 'button'; slotId: number; category: number; pressed: boolean }
  | { kind: 'info'; json: string }
  | { kind: 'ack' }
  | { kind: 'heartbeat' };

/** Build one framed packet. `totalLen` is the length of the WHOLE payload the
 *  packet sequence carries, which for a multi-packet page is larger than `data`.
 *  `data` must fit in FIRST_CHUNK_DATA; the rest of the packet is zero-padded. */
export function buildPacket(
  cmd: number,
  totalLen: number,
  data: Uint8Array = new Uint8Array(0),
): Buffer {
  if (data.length > FIRST_CHUNK_DATA) {
    throw new Error(`packet data ${data.length} B exceeds ${FIRST_CHUNK_DATA} B`);
  }
  const buf = Buffer.alloc(PACKET_SIZE, 0);
  buf[0] = MAGIC[0];
  buf[1] = MAGIC[1];
  buf.writeUInt16BE(cmd, 2);
  buf.writeUInt32LE(totalLen, 4);
  buf.set(data, HEADER_SIZE);
  return buf;
}

/** Split a payload into the wire packet sequence: one framed header packet
 *  carrying the first 1016 bytes, then raw 1024-byte chunks. A payload that fits
 *  entirely in packet 0 yields a single packet. */
export function buildChunks(cmd: number, payload: Uint8Array): Buffer[] {
  const total = payload.length;
  const packets: Buffer[] = [buildPacket(cmd, total, payload.subarray(0, FIRST_CHUNK_DATA))];
  let offset = FIRST_CHUNK_DATA;
  while (offset < total) {
    const chunk = Buffer.alloc(PACKET_SIZE, 0);
    chunk.set(payload.subarray(offset, offset + PACKET_SIZE));
    packets.push(chunk);
    offset += PACKET_SIZE;
  }
  return packets;
}

/** Payload offsets that land on the FIRST byte of a raw (headerless) chunk.
 *  See isPayloadSafe. */
export function chunkBoundaryOffsets(payloadLen: number): number[] {
  const offsets: number[] = [];
  for (let off = FIRST_CHUNK_DATA; off < payloadLen; off += PACKET_SIZE) offsets.push(off);
  return offsets;
}

/** Four independent implementations refuse to send a page whose payload has
 *  0x00 or 0x7c at the first byte of any headerless chunk: the firmware's
 *  reassembler appears to re-sniff those chunks for a frame header (0x7c) or
 *  treat them as padding (0x00) and truncates the archive, which shows up as a
 *  torn or missing image. aleyvag argues the real root cause was a missing
 *  hidraw report-id byte — which cannot happen here, since the driver prepends
 *  it like every other DeckBridge HID write — so the retry counter this guards
 *  is logged: if it stays at 0 on hardware, the workaround can go (plan O8). */
export function isPayloadSafe(payload: Uint8Array): boolean {
  for (const off of chunkBoundaryOffsets(payload.length)) {
    const b = payload[off];
    if (b === 0x00 || b === 0x7c) return false;
  }
  return true;
}

const ASCII = new TextEncoder();

/** Brightness is sent as ASCII digits, not a binary byte — the firmware
 *  strtol()s the payload (confirmed by disassembly in jcalado's FIRMWARE.md). */
export function encodeBrightness(pct: number): Uint8Array {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  return ASCII.encode(String(clamped));
}

const num = (v: number | undefined): string => (v === undefined ? '' : String(Math.round(v)));
const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Pipe-separated ASCII: mode|cpu|mem|hh:mm:ss|gpu|hourFormat|suffix. Trailing
 *  empty fields are kept — the firmware splits on a fixed field count. */
export function encodeSmallWindow(f: SmallWindowFields): Uint8Array {
  const fields = [
    String(f.mode),
    num(f.cpu),
    num(f.mem),
    f.time ?? '',
    num(f.gpu),
    f.hourFormat ?? '24H',
    f.suffix ?? '',
  ];
  return ASCII.encode(fields.join('|'));
}

/** "HH:MM:SS" in local time, for the info-window clock / keepalive. */
export function formatClock(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function decodeJsonPayload(data: Uint8Array, len: number): string {
  const end = Math.min(HEADER_SIZE + len, data.length);
  const body = data.subarray(HEADER_SIZE, end);
  const nul = body.indexOf(0);
  return new TextDecoder().decode(nul < 0 ? body : body.subarray(0, nul)).trim();
}

/** Payload offsets 0/1/3 → absolute 8/9/11. */
function parseButton(data: Uint8Array): IncomingPacket {
  return {
    kind: 'button',
    category: data[HEADER_SIZE] ?? 0,
    slotId: data[HEADER_SIZE + 1] ?? 0,
    pressed: (data[HEADER_SIZE + 3] ?? 0) === 0x01,
  };
}

/** Parse one inbound report. Returns null for anything unrecognised (including a
 *  short read or a missing magic) so the caller can log it verbatim. */
export function parseIncoming(data: Uint8Array): IncomingPacket | null {
  if (data.length < HEADER_SIZE) return null;
  if (data[0] !== MAGIC[0] || data[1] !== MAGIC[1]) return null;
  const cmd = ((data[2] ?? 0) << 8) | (data[3] ?? 0);
  const len =
    (data[4] ?? 0) | ((data[5] ?? 0) << 8) | ((data[6] ?? 0) << 16) | ((data[7] ?? 0) << 24);

  switch (cmd) {
    case CMD.IN_BUTTON:
      return parseButton(data);
    case CMD.IN_DEVICE_INFO:
      return { kind: 'info', json: decodeJsonPayload(data, len) };
    case CMD.IN_ZIP_ACK:
      return { kind: 'ack' };
    case CMD.IN_HEARTBEAT:
      return { kind: 'heartbeat' };
    default:
      return null;
  }
}

/** Human describers for the WebUI comm log, keyed by opcode — the counterpart of
 *  CRT_DESCRIBERS in mirabox-protocol.ts. `totalLen` is the header's length
 *  field, so a multi-packet page reads as its full size on packet 0. */
export const CMD_DESCRIBERS: Record<number, (totalLen: number, payload: Uint8Array) => string> = {
  [CMD.SET_BUTTONS]: (n) => `SET_BUTTONS zip=${n}B`,
  [CMD.PARTIAL_UPDATE]: (n) => `PARTIAL_UPDATE zip=${n}B`,
  [CMD.SMALL_WINDOW]: (_n, p) => `SMALL_WINDOW ${new TextDecoder().decode(p)}`,
  [CMD.BRIGHTNESS]: (_n, p) => `BRIGHTNESS ${new TextDecoder().decode(p)}`,
  [CMD.LABEL_STYLE]: (n) => `LABEL_STYLE json=${n}B`,
  [CMD.LOCK]: () => 'LOCK_SCREEN',
  [CMD.UNLOCK]: () => 'UNLOCK_SCREEN',
};

/** Describe an outbound packet for the comm log. Raw (headerless) page chunks
 *  have no magic, so they are reported as such. */
export function describeOutgoing(pkt: Uint8Array): string {
  if (pkt[0] !== MAGIC[0] || pkt[1] !== MAGIC[1]) return 'page-data chunk';
  const cmd = ((pkt[2] ?? 0) << 8) | (pkt[3] ?? 0);
  const totalLen =
    (pkt[4] ?? 0) | ((pkt[5] ?? 0) << 8) | ((pkt[6] ?? 0) << 16) | ((pkt[7] ?? 0) << 24);
  const describe = CMD_DESCRIBERS[cmd];
  const inline = pkt.subarray(HEADER_SIZE, HEADER_SIZE + Math.min(totalLen, FIRST_CHUNK_DATA));
  if (describe) return describe(totalLen, inline);
  return `cmd 0x${cmd.toString(16).padStart(4, '0')} len=${totalLen}`;
}

/** Describe an inbound report for the comm log. */
export function describeIncoming(parsed: IncomingPacket | null): string {
  if (!parsed) return 'unknown input';
  switch (parsed.kind) {
    case 'button': {
      const what = parsed.category === INPUT_CATEGORY_WIDE ? 'BUTTON (wide window)' : 'BUTTON';
      return `${what} slot=${parsed.slotId} ${parsed.pressed ? 'press' : 'release'}`;
    }
    case 'info':
      return `DEVICE_INFO ${parsed.json}`;
    case 'ack':
      return 'ZIP ACK';
    case 'heartbeat':
      return 'heartbeat';
  }
}
