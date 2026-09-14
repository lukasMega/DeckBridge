// Disk sink for logger.ts: <cacheRoot>/logs/deckbridge.log, size-rotated.
//
// Exists for the reports where the WebUI never starts (the in-app log panel is
// then unreachable, and release builds are __SIMPLE_ONLY__ so the advanced log
// panel isn't even in the bundle) — the file is the only surviving evidence.
//
// Main thread only. A worker forwards its lines via postMessage and the main
// thread re-logs them through logger.ts, so there is exactly one writer and one
// file handle; see FileSinkFn in logger.ts.
import { setFileSink, warn } from './logger.js';
import type { LogLevel } from './logger.js';
import { defaultCacheRoot } from './native-libs.js';

/** Rotate once the active file passes this; keep LOG_FILES_KEPT files total
 *  (≈6 MB ceiling) so the set stays small enough to attach to an issue. */
export const LOG_ROTATE_BYTES = 2 * 1024 * 1024;
export const LOG_FILES_KEPT = 3;
/** Writes are batched: per-entry I/O on the main thread competes with the CORA
 *  ACK hot path (same rationale as activity-buffers.ts). warn/error flush at
 *  once — a hang must not swallow the last line before the stall. */
export const LOG_FLUSH_MS = 250;

const LEVEL_TAG: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR',
};

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
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms} ${LEVEL_TAG[level]} [${component}] ${message}`;
}

interface FileHandleLike {
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
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();
  /** Set after any write/rotate error — the sink then silently drops lines. A
   *  broken log file must never take down the app. */
  private disabled = false;
  /** Prefix the next written line with an ISO date (first line, post-rotation). */
  private needDateHeader = true;

  constructor(cacheRoot: string = defaultCacheRoot()) {
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
    this.pending.push(formatLine(level, component, message, ts));
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
    this.writing = this.writing.then(() => this.drain());
    return this.writing;
  }

  /** Close the handle after a final drain (shutdown / tray quit). */
  async close(): Promise<void> {
    await this.flush();
    const h = this.handle;
    this.handle = null;
    await h?.close().catch(() => undefined);
  }

  private async drain(): Promise<void> {
    if (this.disabled || this.pending.length === 0) return;
    const lines = this.pending;
    this.pending = [];
    try {
      await this.ensureOpen();
      if (this.needDateHeader) {
        lines.unshift(`──── ${new Date().toISOString()} ────`);
        this.needDateHeader = false;
      }
      const bytes = new TextEncoder().encode(lines.join('\n') + '\n');
      await this.handle!.write(bytes);
      this.size += bytes.length;
      if (this.size >= LOG_ROTATE_BYTES) await this.rotate();
    } catch (e) {
      this.disabled = true;
      this.handle = null;
      // Reported through the console/WebUI sinks; this one is off now, so the
      // warn can't recurse into another failing write.
      warn('logfile', `disabling log file (${this.path}): ${(e as Error).message}`);
    }
  }

  private async ensureOpen(): Promise<void> {
    if (this.handle) return;
    await tjs.makeDir(logDir(this.root), { recursive: true });
    this.size = await fileSize(this.path);
    this.handle = await tjs.open(this.path, 'a');
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

/** Last `maxLines` lines of the active log file (diagnostics bundle). Returns
 *  '' when unreadable — the bundle falls back to the in-memory ring buffer. */
export async function tailLogFile(maxLines: number, cacheRoot?: string): Promise<string> {
  const path = cacheRoot ? logFilePath(cacheRoot) : (activeLogFilePath() ?? logFilePath());
  try {
    const text = new TextDecoder().decode(await tjs.readFile(path));
    const lines = text.split('\n');
    return lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
  } catch {
    return '';
  }
}
