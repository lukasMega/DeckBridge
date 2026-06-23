// Shared CORA protocol test framer + event-wait helpers.
//
// NOTE: this file is intentionally NOT named `*.test.ts` so scripts/run-tests.mjs
// (which globs `test/*.test.ts`) never runs it as a standalone test — it is only
// imported by the real test files and bundled in via esbuild.
import type { ElgatoServer, ElgatoChildServer } from '../../src/elgato.js';
import { ELGATO_PKT_SIZE_RX } from '../../src/types.js';
import { encodeCoraFrame, tryDecodeCoraFrame, type CoraFrame } from '../../src/cora-frame.js';

// ── Framer ───────────────────────────────────────────────────────────────────

class TjsFramer {
  private buf = Buffer.alloc(0);
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly socket: TjsTCPSocket;

  constructor(
    socket: TjsTCPSocket,
    readable: ReadableStream<Uint8Array>,
    writable: WritableStream<Uint8Array>,
  ) {
    this.socket = socket;
    this.reader = readable.getReader();
    this.writer = writable.getWriter();
  }

  async recv(timeoutMs = 2000): Promise<CoraFrame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const frame = tryDecodeCoraFrame(this.buf);
      if (frame) {
        this.buf = this.buf.subarray(16 + frame.payload.length) as Buffer;
        return frame;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('recv timeout');
      const chunk = await Promise.race([
        this.reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('recv timeout')), remaining),
        ),
      ]);
      if (chunk.done) throw new Error('connection closed');
      this.buf = Buffer.concat([this.buf, Buffer.from(chunk.value)]);
    }
  }

  async write(data: Uint8Array): Promise<void> {
    await this.writer.write(data);
  }

  close(): void {
    this.socket.close();
  }
}

export async function connect(port: number): Promise<TjsFramer> {
  const sock = await tjs.connect('tcp', '127.0.0.1', port);
  const { readable, writable } = await sock.opened;
  return new TjsFramer(sock, readable, writable);
}

function waitForEvent(
  emitter: { once(e: string, cb: (...a: unknown[]) => void): void },
  event: string,
  timeoutMs = 1000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for '${event}'`)), timeoutMs);
    emitter.once(event, () => {
      clearTimeout(t);
      resolve();
    });
  });
}

export function waitForValue<T>(
  emitter: { once(e: string, cb: (...a: unknown[]) => void): void },
  event: string,
  timeoutMs = 1000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for '${event}'`)), timeoutMs);
    emitter.once(event, (v: unknown) => {
      clearTimeout(t);
      resolve(v as T);
    });
  });
}

export async function closeAndWait(
  server: ElgatoServer | ElgatoChildServer,
  framer: TjsFramer,
): Promise<void> {
  const p = waitForEvent(server, 'clientDisconnected', 2000);
  framer.close();
  await p;
}

export async function sendPkt(
  framer: TjsFramer,
  byte0: number,
  byte1: number,
  extra?: { flags?: number; messageId?: number },
): Promise<void> {
  const payload = Buffer.alloc(ELGATO_PKT_SIZE_RX);
  payload[0] = byte0;
  payload[1] = byte1;
  await framer.write(encodeCoraFrame(payload, extra?.flags ?? 0, 0, extra?.messageId ?? 0));
}

export async function sendFrame(
  framer: TjsFramer,
  payload: Buffer,
  flags = 0,
  hidOp = 0,
  messageId = 0,
): Promise<void> {
  await framer.write(encodeCoraFrame(payload, flags, hidOp, messageId));
}
