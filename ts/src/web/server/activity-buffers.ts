import type { Broadcaster } from './broadcaster.js';
import type { KeyEventEntry, LogEntry, LogLevel } from './types.js';
import type { CommEntry, KeyState } from '../../types.js';
import {
  KEY_EVENT_BUFFER_MAX,
  COMM_BUFFER_MAX,
  COMM_BROADCAST_FLUSH_MS,
  LOG_BUFFER_MAX,
  clearRepeating,
} from '../../types.js';

/** Ring buffers for log / CORA-comm / key-event entries, each broadcast to WS
 *  clients. Comm AND log entries are batched on one shared timer: image bursts
 *  produce one comm entry per 1024B chunk (rx + tx) plus a log line per key
 *  transform, and per-entry broadcasts would compete with the image hot path.
 *  Ordering is preserved within each kind. */
export class ActivityBuffers {
  readonly logs: LogEntry[] = [];
  readonly comms: CommEntry[] = [];
  readonly keyEvents: KeyEventEntry[] = [];
  private readonly flushQueue: CommEntry[] = [];
  private readonly logFlushQueue: LogEntry[] = [];
  private flushTimer: number | null = null;

  constructor(private readonly bus: Broadcaster) {}

  keyEvent(mk2Index: number, state: KeyState, wireId?: number): void {
    const entry: KeyEventEntry = {
      ts: Date.now(),
      mk2Index,
      state,
      ...(wireId !== undefined ? { wireId } : {}),
    };
    this.push(this.keyEvents, entry, KEY_EVENT_BUFFER_MAX);
    this.bus.broadcast('keyEvent', entry);
  }

  comm(entry: Omit<CommEntry, 'ts'>): void {
    const full: CommEntry = { ts: Date.now(), ...entry };
    // Ring buffer always fills — diagnostics reads it — but the WS broadcast is
    // advanced-view-only: the simple UI has no comm/log panel to receive it.
    this.push(this.comms, full, COMM_BUFFER_MAX);
    if (!__SIMPLE_ONLY__) {
      this.push(this.flushQueue, full, COMM_BUFFER_MAX);
      this.startFlush();
    }
  }

  log(level: LogLevel, component: string, message: string): void {
    const entry: LogEntry = { ts: Date.now(), level, component, message };
    this.push(this.logs, entry, LOG_BUFFER_MAX);
    if (!__SIMPLE_ONLY__) {
      // Batched on comm()'s timer for the same reason: one broadcast per entry competes
      // with the image hot path. The advanced log panel rAF-coalesces appends anyway.
      this.push(this.logFlushQueue, entry, LOG_BUFFER_MAX);
      this.startFlush();
    }
  }

  stop(): void {
    this.stopFlush();
    this.flushQueue.length = 0;
    this.logFlushQueue.length = 0;
  }

  private push<T>(buf: T[], entry: T, max: number): void {
    buf.push(entry);
    if (buf.length > max) buf.shift();
  }

  private startFlush(): void {
    if (this.flushTimer === null) {
      this.flushTimer = setInterval(() => this.flush(), COMM_BROADCAST_FLUSH_MS);
    }
  }

  private stopFlush(): void {
    this.flushTimer = clearRepeating(this.flushTimer);
  }

  private flush(): void {
    // A synchronous throw here would kill the process (no global hook for
    // sync setInterval callbacks) — keep it non-throwing.
    try {
      if (this.flushQueue.length === 0 && this.logFlushQueue.length === 0) {
        this.stopFlush();
        return;
      }
      if (this.flushQueue.length > 0) {
        this.bus.broadcast('commBatch', this.flushQueue.splice(0, this.flushQueue.length));
      }
      if (this.logFlushQueue.length > 0) {
        this.bus.broadcast('logBatch', this.logFlushQueue.splice(0, this.logFlushQueue.length));
      }
    } catch (e) {
      try {
        this.log('error', 'webui', `comm-flush failed: ${(e as Error).message}`);
      } catch {
        /* logging itself failed — drop */
      }
    }
  }
}
