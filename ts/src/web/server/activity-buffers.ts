import type { Broadcaster } from './broadcaster.js';
import type { KeyEventEntry, LogEntry, LogLevel } from './types.js';
import type { CommEntry, KeyState } from '../../types.js';
import {
  KEY_EVENT_BUFFER_MAX,
  COMM_BUFFER_MAX,
  COMM_BROADCAST_FLUSH_MS,
  LOG_BUFFER_MAX,
} from '../../types.js';

/** Ring buffers for log / CORA-comm / key-event entries, each broadcast to WS
 *  clients. Comm entries are batched on a timer: image bursts produce one entry
 *  per 1024B chunk (rx + tx), and per-entry broadcasts would compete with the
 *  image hot path. Ordering is preserved. */
export class ActivityBuffers {
  readonly logs: LogEntry[] = [];
  readonly comms: CommEntry[] = [];
  readonly keyEvents: KeyEventEntry[] = [];
  private readonly flushQueue: CommEntry[] = [];
  private flushTimer: number | null = null;

  constructor(private readonly bus: Broadcaster) {}

  keyEvent(mk2Index: number, state: KeyState): void {
    const entry: KeyEventEntry = { ts: Date.now(), mk2Index, state };
    this.push(this.keyEvents, entry, KEY_EVENT_BUFFER_MAX);
    this.bus.broadcast('keyEvent', entry);
  }

  comm(entry: Omit<CommEntry, 'ts'>): void {
    const full: CommEntry = { ts: Date.now(), ...entry };
    this.push(this.comms, full, COMM_BUFFER_MAX);
    this.push(this.flushQueue, full, COMM_BUFFER_MAX);
    if (this.flushTimer === null) {
      this.flushTimer = setInterval(() => this.flush(), COMM_BROADCAST_FLUSH_MS);
    }
  }

  log(level: LogLevel, component: string, message: string): void {
    const entry: LogEntry = { ts: Date.now(), level, component, message };
    this.push(this.logs, entry, LOG_BUFFER_MAX);
    this.bus.broadcast('log', entry);
  }

  stop(): void {
    this.stopFlush();
    this.flushQueue.length = 0;
  }

  private push<T>(buf: T[], entry: T, max: number): void {
    buf.push(entry);
    if (buf.length > max) buf.shift();
  }

  private stopFlush(): void {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private flush(): void {
    // A synchronous throw here would kill the process (no global hook for
    // sync setInterval callbacks) — keep it non-throwing.
    try {
      if (this.flushQueue.length === 0) {
        this.stopFlush();
        return;
      }
      this.bus.broadcast('commBatch', this.flushQueue.splice(0, this.flushQueue.length));
    } catch (e) {
      try {
        this.log('error', 'webui', `comm-flush failed: ${(e as Error).message}`);
      } catch {
        /* logging itself failed — drop */
      }
    }
  }
}
