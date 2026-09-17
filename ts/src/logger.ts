declare const __LOG_LEVEL__: number;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_MAP: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };

// Runtime override of the build-time __LOG_LEVEL__ (--log-level / DECKBRIDGE_LOG_LEVEL).
// Read from env at module load too — this module runs in both the main thread and the
// USB worker thread (separate bundles, separate JS environments), and tjs.env is real
// process-wide getenv/setenv, so a worker's own top-level read here already sees any
// env value the main thread set before the worker was spawned. The main thread itself
// still needs the explicit setLogLevel() call from app.ts (below), because THIS
// module's imports (hence this top-level read) evaluate before app.ts's own body runs
// applyFlagsToEnv — same ESM-import-order hazard as bindAddr() in types.ts.
function levelFromEnv(): number | undefined {
  const v = typeof tjs !== 'undefined' ? tjs.env.DECKBRIDGE_LOG_LEVEL : undefined;
  return v !== undefined ? LOG_LEVEL_MAP[v] : undefined;
}

let currentLevel = levelFromEnv() ?? __LOG_LEVEL__;

export function setLogLevel(level: string): void {
  const n = LOG_LEVEL_MAP[level];
  if (n !== undefined) currentLevel = n;
}

/** True if `level` would actually be emitted. Guard hot-path call sites with this
 *  BEFORE building the message — the fns below discard by level, but only after the
 *  caller paid for the interpolation. A predicate, not a thunk: no closure per call. */
export function isLevelEnabled(level: LogLevel): boolean {
  return currentLevel <= (LOG_LEVEL_MAP[level] ?? 1);
}

/** The level currently in effect, as a name — for the diagnostics header. */
export function currentLogLevel(): LogLevel | 'silent' {
  return (
    (Object.keys(LOG_LEVEL_MAP).find((k) => LOG_LEVEL_MAP[k] === currentLevel) as
      | LogLevel
      | 'silent'
      | undefined) ?? 'info'
  );
}

type WebUILogFn = (level: LogLevel, component: string, message: string) => void;
/** Disk sink, installed by log-file.ts on the MAIN thread only — a worker
 *  forwards via `_workerPost` and never writes the file itself, so there is
 *  exactly one writer and no cross-thread interleave. */
type FileSinkFn = (level: LogLevel, component: string, message: string, ts: number) => void;
type WorkerPostFn = (msg: {
  type: 'log';
  level: LogLevel;
  component: string;
  message: string;
}) => void;

let _webuiLog: WebUILogFn | null = null;
let _workerPost: WorkerPostFn | null = null;
let _fileSink: FileSinkFn | null = null;

export function setWebUILog(fn: WebUILogFn): void {
  _webuiLog = fn;
}
/** Install (or, with null, remove) the disk sink. See FileSinkFn. */
export function setFileSink(fn: FileSinkFn | null): void {
  _fileSink = fn;
}
export function setWorkerPost(fn: WorkerPostFn): void {
  _workerPost = fn;
}

/** `HH:MM:SS.mmm`. Shared with log-file.ts so console and file lines match. */
export function formatTime(d: Date = new Date()): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/** Padded so the `[component]` column lines up. Also the log file's tags. */
export const LEVEL_TAG: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR',
};

// In a worker thread `_workerPost` is set: forward to the main thread, which
// re-logs through this same module (console + WebUI). Doing BOTH the local
// console.* AND the post would print every worker line twice in the terminal
// (once from the worker's stdout, once from the main re-log) — so a worker
// posts only, and the main thread (no `_workerPost`) is the sole console writer.
export function debug(component: string, message: string): void {
  if (currentLevel <= 0) {
    if (_workerPost) return _workerPost({ type: 'log', level: 'debug', component, message });
    console.debug(`${formatTime()} ${LEVEL_TAG.debug} [${component}] ${message}`);
    _webuiLog?.('debug', component, message);
    _fileSink?.('debug', component, message, Date.now());
  }
}

export function info(component: string, message: string): void {
  if (currentLevel <= 1) {
    if (_workerPost) return _workerPost({ type: 'log', level: 'info', component, message });
    console.log(`${formatTime()} ${LEVEL_TAG.info} [${component}] ${message}`);
    _webuiLog?.('info', component, message);
    _fileSink?.('info', component, message, Date.now());
  }
}

export function warn(component: string, message: string): void {
  if (currentLevel <= 2) {
    if (_workerPost) return _workerPost({ type: 'log', level: 'warn', component, message });
    console.warn(`${formatTime()} ${LEVEL_TAG.warn} [${component}] ${message}`);
    _webuiLog?.('warn', component, message);
    _fileSink?.('warn', component, message, Date.now());
  }
}

export function error(component: string, message: string): void {
  if (currentLevel <= 3) {
    if (_workerPost) return _workerPost({ type: 'log', level: 'error', component, message });
    console.error(`${formatTime()} ${LEVEL_TAG.error} [${component}] ${message}`);
    _webuiLog?.('error', component, message);
    _fileSink?.('error', component, message, Date.now());
  }
}

/** Paired breadcrumb around a blocking startup step: an `info` line before, and
 *  one with the elapsed ms after (or on throw). When the process wedges, the
 *  last line in the log file is the unpaired "start" — which names the step
 *  that hung. Re-throws so callers keep their own error handling. */
export async function step<T>(
  component: string,
  name: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  info(component, `▶ ${name}`);
  const t0 = Date.now();
  try {
    const result = await fn();
    info(component, `✔ ${name} (${Date.now() - t0}ms)`);
    return result;
  } catch (e) {
    warn(component, `✘ ${name} failed after ${Date.now() - t0}ms: ${(e as Error).message}`);
    throw e;
  }
}

export function log(level: LogLevel, component: string, message: string): void {
  if (level === 'debug') debug(component, message);
  else if (level === 'info') info(component, message);
  else if (level === 'warn') warn(component, message);
  else error(component, message);
}
