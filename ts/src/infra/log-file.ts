// Disk sink for logger.ts: <cacheRoot>/logs/deckbridge.log, size-rotated.
//
// Exists for the reports where the WebUI never starts (the in-app log panel is
// then unreachable, and release builds are __SIMPLE_ONLY__ so the advanced log
// panel isn't even in the bundle) — the file is the only surviving evidence.
//
// Main thread only. A worker forwards its lines via postMessage and the main
// thread re-logs them through logger.ts, so there is exactly one writer and one
// file handle; see FileSinkFn in logger.ts.
import { formatTime, LEVEL_TAG, setFileSink, warn } from '../shared/logger.js';
import type { LogLevel } from '../shared/logger.js';
import { defaultCacheRoot } from './native-libs.js';

/** Rotate once the active file passes this; keep LOG_FILES_KEPT files total
 *  (≈6 MB ceiling) so the set stays small enough to attach to an issue. */
export const LOG_ROTATE_BYTES = 2 * 1024 * 1024;
export const LOG_FILES_KEPT = 3;
/** Writes are batched: per-entry I/O on the main thread competes with the CORA
 *  ACK hot path (same rationale as activity-buffers.ts). warn/error flush at
 *  once — a hang must not swallow the last line before the stall. */
export const LOG_FLUSH_MS = 250;
/** Unwritten lines are capped (UTF-16 units ≈ bytes): a stalled disk must not grow
 *  the queue without bound; the oldest lines go first and the loss is marked. */
export const LOG_PENDING_MAX_BYTES = 1024 * 1024;

export function logDir(cacheRoot: string = defaultCacheRoot()): string {
  return `${cacheRoot}/logs`;
}

/** Active log file. Rotated files are `deckbridge.1.log` … `deckbridge.N.log`. */
export function logFilePath(cacheRoot: string = defaultCacheRoot()): string {
  return `${logDir(cacheRoot)}/deckbridge.log`;
}

function rotatedPath(cacheRoot: string, n: number): string {
  return `${logDir(cacheRoot)}/deckbridge.${n}.log`;
}

/** `HH:MM:SS.mmm LEVEL [component] message` — same shape as the console line. */
export function formatLine(
  level: LogLevel,
  component: string,
  message: string,
  ts: number,
): string {
  return `${formatTime(new Date(ts))} ${LEVEL_TAG[level]} [${component}] ${message}`;
}

export interface FileHandleLike {
  write(data: Uint8Array): Promise<number | void>;
  close(): Promise<void>;
}

/** One log file: batched append + size rotation. A single instance is installed
 *  as the process-wide sink by `startLogFile()`; tests drive their own. */
export class LogFileSink {
  private readonly root: string;
  private handle: FileHandleLike | null = null;
  private size = 0;
  private pending: string[] = [];
  private pendingBytes = 0;
  private dropped = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();
  /** The one flush waiting behind the running drain; later callers share it. */
  private queued: Promise<void> | null = null;
  /** Why the sink was disabled, so close() can tell the shutdown coordinator. */
  private failure: Error | null = null;
  /** Set after any write/rotate error — the sink then silently drops lines. A
   *  broken log file must never take down the app. */
  private disabled = false;
  /** Prefix the next written line with an ISO date (first line, post-rotation). */
  private needDateHeader = true;

  /** `openFile` is a test seam for short-write / failing-handle cases. */
  constructor(
    cacheRoot: string = defaultCacheRoot(),
    private readonly openFile: (path: string) => Promise<FileHandleLike> = (path) =>
      tjs.open(path, 'a'),
  ) {
    this.root = cacheRoot;
  }

  get path(): string {
    return logFilePath(this.root);
  }

  get isDisabled(): boolean {
    return this.disabled;
  }

  /** Queue one line. warn/error flush immediately; everything else rides the
   *  LOG_FLUSH_MS timer. */
  write(level: LogLevel, component: string, message: string, ts: number): void {
    if (this.disabled) return;
    const line = formatLine(level, component, message, ts);
    this.pending.push(line);
    this.pendingBytes += line.length;
    while (this.pendingBytes > LOG_PENDING_MAX_BYTES && this.pending.length > 1) {
      this.pendingBytes -= this.pending.shift()!.length;
      this.dropped++;
    }
    if (level === 'warn' || level === 'error') {
      void this.flush();
      return;
    }
    this.timer ??= setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, LOG_FLUSH_MS);
  }

  /** Drain the queue to disk. Serialized on `writing` so two overlapping calls
   *  can't interleave chunks or race the rotation. */
  flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.queued) return this.queued;
    const next = this.writing.then(() => {
      this.queued = null;
      return this.drain();
    });
    this.queued = next;
    this.writing = next;
    return next;
  }

  /** Close the handle after a final drain (shutdown / tray quit). Rejects when
   *  lines were lost (sink disabled by a write error) or the handle won't close. */
  async close(): Promise<void> {
    await this.flush();
    const h = this.handle;
    this.handle = null;
    let closeError: Error | null = null;
    try {
      await h?.close();
    } catch (e) {
      closeError = asError(e);
    }
    const failure = this.failure ?? closeError;
    if (failure) throw new Error(`log file ${this.path}: ${failure.message}`);
  }

  private async drain(): Promise<void> {
    if (this.disabled || this.pending.length === 0) return;
    const lines = this.pending;
    const dropped = this.dropped;
    this.pending = [];
    this.pendingBytes = 0;
    this.dropped = 0;
    let handle: FileHandleLike | null = null;
    try {
      await this.ensureOpen();
      handle = this.handle;
      if (dropped > 0) lines.unshift(`[logfile] ${dropped} lines dropped (disk too slow)`);
      if (this.needDateHeader) {
        lines.unshift(`──── ${new Date().toISOString()} ────`);
        this.needDateHeader = false;
      }
      const bytes = new TextEncoder().encode(lines.join('\n') + '\n');
      let offset = 0;
      while (offset < bytes.length) {
        // write() reports the bytes actually written; a short write must be continued.
        const n = await handle!.write(bytes.subarray(offset));
        const wrote = typeof n === 'number' ? n : bytes.length - offset;
        if (wrote <= 0) throw new Error('write made no progress');
        offset += wrote;
        this.size += wrote;
      }
      if (this.size >= LOG_ROTATE_BYTES) await this.rotate();
    } catch (e) {
      this.disabled = true;
      this.failure = asError(e);
      this.handle = null;
      this.pending = [];
      this.pendingBytes = 0;
      // Release the descriptor; it is otherwise unreachable once discarded.
      await handle?.close().catch(() => undefined);
      // Reported through the console/WebUI sinks; this one is off now, so the
      // warn can't recurse into another failing write.
      warn('logfile', `disabling log file (${this.path}): ${this.failure.message}`);
    }
  }

  private async ensureOpen(): Promise<void> {
    if (this.handle) return;
    await tjs.makeDir(logDir(this.root), { recursive: true });
    this.size = await fileSize(this.path);
    this.handle = await this.openFile(this.path);
  }

  /** deckbridge.log → .1.log, .1 → .2, … dropping the oldest. */
  private async rotate(): Promise<void> {
    await this.handle?.close().catch(() => undefined);
    this.handle = null;
    for (let n = LOG_FILES_KEPT - 1; n >= 1; n--) {
      const from = n === 1 ? this.path : rotatedPath(this.root, n - 1);
      const to = rotatedPath(this.root, n);
      try {
        await tjs.remove(to);
      } catch {}
      try {
        await tjs.rename(from, to);
      } catch {}
    }
    this.size = 0;
    this.needDateHeader = true;
  }
}

const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

async function fileSize(path: string): Promise<number> {
  try {
    return (await tjs.stat(path)).size;
  } catch {
    return 0;
  }
}

let _sink: LogFileSink | null = null;

/** Install the process-wide disk sink. Called from app.ts before any HID/native
 *  work so a freeze during startup still leaves breadcrumbs on disk. */
export function startLogFile(cacheRoot: string = defaultCacheRoot()): LogFileSink {
  _sink ??= new LogFileSink(cacheRoot);
  const sink = _sink;
  setFileSink((level, component, message, ts) => sink.write(level, component, message, ts));
  return sink;
}

/** Path of the active log file, or null when no sink is installed. */
export function activeLogFilePath(): string | null {
  return _sink ? _sink.path : null;
}

/** Drain + close the sink (shutdown path). Safe when none was installed. */
export async function stopLogFile(): Promise<void> {
  const sink = _sink;
  if (!sink) return;
  setFileSink(null);
  _sink = null;
  await sink.close();
}

/** Bytes read from the file end: bounds memory + decode cost however large the log is. */
export const LOG_TAIL_MAX_BYTES = 256 * 1024;

/** Last `maxLines` lines of the active log file (diagnostics bundle), reading at most
 *  `maxBytes` from the end. Returns '' when unreadable — the bundle falls back to
 *  the in-memory ring buffer. */
export async function tailLogFile(
  maxLines: number,
  cacheRoot?: string,
  maxBytes = LOG_TAIL_MAX_BYTES,
): Promise<string> {
  const path = cacheRoot ? logFilePath(cacheRoot) : (activeLogFilePath() ?? logFilePath());
  let fh: TjsFileHandle | null = null;
  try {
    fh = await tjs.open(path, 'r');
    const { size } = await fh.stat();
    const start = Math.max(0, size - maxBytes);
    const buf = new Uint8Array(size - start);
    let got = 0;
    while (got < buf.length) {
      const n = await fh.read(buf.subarray(got), start + got);
      if (!n) break;
      got += n;
    }
    let text = new TextDecoder().decode(buf.subarray(0, got));
    // A mid-file start cuts the first line (and maybe a UTF-8 char): drop it.
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    const lines = text.split('\n');
    return lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
  } catch {
    return '';
  } finally {
    await fh?.close().catch(() => undefined);
  }
}
