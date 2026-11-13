// Asks a running DeckBridge for the dock identity (serial, PID, child port) the same way
// Elgato does, so the relay can advertise it. Runs before the relay listens, because the
// primary accepts a single client at a time.
import { CoraFrameReader, encodeCoraFrame } from '../../cora/frame.js';
import type { CoraFrame } from '../../cora/frame.js';
import {
  CORA_SERIAL_DATA_OFFSET,
  CORA_SERIAL_LEN_OFFSET,
  ELGATO_PKT_SIZE_RX,
  ELGATO_VID,
  EVENT_SUBTYPE_CAPABILITIES,
  FEATURE_GET_CAPABILITIES,
  FEATURE_GET_DOCK_SERIAL,
  PAYLOAD_TYPE_FEATURE,
  PKT_EVENT,
} from '../../cora/protocol.js';

export interface DockIdentity {
  serial: string;
  productId: number;
  childPort: number;
}

// Offsets written by buildCapabilitiesPacket (cora/responses.ts).
const CAPS_VID_OFFSET = 26;
const CAPS_PID_OFFSET = 28;
const CAPS_PORT_OFFSET = 126;

/** Longest serial accepted; real docks send 14 characters. */
const SERIAL_MAX_LEN = 64;
const DEFAULT_TIMEOUT_MS = 3000;

/** 1024-byte non-VERB feature request payload: [0x03, reportId, 0…]. */
export function featureRequest(reportId: number): Buffer {
  const pkt = Buffer.alloc(ELGATO_PKT_SIZE_RX);
  pkt[0] = PAYLOAD_TYPE_FEATURE;
  pkt[1] = reportId;
  return pkt;
}

/** Serial from a 0x84 reply payload, or null if the payload is not one. */
export function parseSerialReply(payload: Buffer): string | null {
  if (payload[0] !== PAYLOAD_TYPE_FEATURE || payload[1] !== FEATURE_GET_DOCK_SERIAL) return null;
  const len = payload[CORA_SERIAL_LEN_OFFSET] ?? 0;
  if (len === 0 || CORA_SERIAL_DATA_OFFSET + len > payload.length) return null;
  return payload.toString('ascii', CORA_SERIAL_DATA_OFFSET, CORA_SERIAL_DATA_OFFSET + len);
}

/** PID + child port from a 0x1c caps reply payload, or null (wrong type or VID). */
export function parseCapsReply(payload: Buffer): { productId: number; childPort: number } | null {
  if (payload.length < CAPS_PORT_OFFSET + 2) return null;
  if (payload[0] !== PKT_EVENT || payload[1] !== EVENT_SUBTYPE_CAPABILITIES) return null;
  if (payload.readUInt16LE(CAPS_VID_OFFSET) !== ELGATO_VID) return null;
  return {
    productId: payload.readUInt16LE(CAPS_PID_OFFSET),
    childPort: payload.readUInt16LE(CAPS_PORT_OFFSET),
  };
}

const noop = (): void => {};

interface Probe {
  abort: AbortController;
  timedOut: boolean;
  sock: TjsTCPSocket | null;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  writer: WritableStreamDefaultWriter<Uint8Array> | null;
  frames: CoraFrameReader;
  /** Frames drained but not consumed yet. */
  queue: CoraFrame[];
}

async function connectProbe(p: Probe, host: string, port: number): Promise<void> {
  try {
    p.sock = await tjs.connect('tcp', host, port, { signal: p.abort.signal });
    const info = await p.sock.opened;
    p.reader = info.readable.getReader();
    p.writer = info.writable.getWriter();
  } catch (e) {
    throw new Error(p.timedOut ? 'timeout' : `connect failed: ${errorMessage(e)}`, { cause: e });
  }
}

async function sendRequest(p: Probe, reportId: number): Promise<void> {
  await p.writer?.write(encodeCoraFrame(featureRequest(reportId), 0, 0, 0)).catch(noop);
}

/** Next frame payload that `parse` accepts; other frames (keepalives) are skipped. */
async function readReply<T>(p: Probe, parse: (payload: Buffer) => T | null): Promise<T> {
  for (;;) {
    for (let f = p.queue.shift(); f; f = p.queue.shift()) {
      const v = parse(f.payload);
      if (v !== null) return v;
    }
    const chunk = await p.reader?.read().catch(() => null);
    if (p.timedOut) throw new Error('timeout');
    if (!chunk || chunk.done) throw new Error('closed before reply');
    p.frames.append(Buffer.wrap(chunk.value));
    p.queue.push(...p.frames.drainFrames());
  }
}

function closeProbe(p: Probe): void {
  // Close the handle ourselves: txiki only does it once both halves finish.
  void p.reader?.cancel().catch(noop);
  void p.writer?.abort().catch(noop);
  try {
    p.sock?.close();
  } catch {
    // already closed
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Connects to host:port, asks 0x84 then 0x1c, closes. Rejects with a short reason. */
export async function probeIdentity(
  host: string,
  port: number,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<DockIdentity> {
  const p: Probe = {
    abort: new AbortController(),
    timedOut: false,
    sock: null,
    reader: null,
    writer: null,
    frames: new CoraFrameReader(),
    queue: [],
  };
  // One timer for the whole probe; cancelling the reader ends a read still pending.
  const timer = setTimeout(function onTimeout() {
    p.timedOut = true;
    p.abort.abort();
    void p.reader?.cancel().catch(noop);
  }, timeoutMs);

  try {
    await connectProbe(p, host, port);
    await sendRequest(p, FEATURE_GET_DOCK_SERIAL);
    const serial = await readReply(p, parseSerialReply);
    if (serial.length > SERIAL_MAX_LEN) throw new Error('serial too long');
    await sendRequest(p, FEATURE_GET_CAPABILITIES);
    const caps = await readReply(p, parseCapsReply);
    return { serial, ...caps };
  } finally {
    clearTimeout(timer);
    closeProbe(p);
  }
}
