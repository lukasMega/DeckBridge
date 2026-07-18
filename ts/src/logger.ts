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

type WebUILogFn = (level: LogLevel, component: string, message: string) => void;
type WorkerPostFn = (msg: {
  type: 'log';
  level: LogLevel;
  component: string;
  message: string;
}) => void;

let _webuiLog: WebUILogFn | null = null;
let _workerPost: WorkerPostFn | null = null;

export function setWebUILog(fn: WebUILogFn): void {
  _webuiLog = fn;
}
export function setWorkerPost(fn: WorkerPostFn): void {
  _workerPost = fn;
}

function ts(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

// In a worker thread `_workerPost` is set: forward to the main thread, which
// re-logs through this same module (console + WebUI). Doing BOTH the local
// console.* AND the post would print every worker line twice in the terminal
// (once from the worker's stdout, once from the main re-log) — so a worker
// posts only, and the main thread (no `_workerPost`) is the sole console writer.
export function debug(component: string, message: string): void {
  if (currentLevel <= 0) {
    if (_workerPost) return _workerPost({ type: 'log', level: 'debug', component, message });
    console.debug(`${ts()} DEBUG [${component}] ${message}`);
    _webuiLog?.('debug', component, message);
  }
}

export function info(component: string, message: string): void {
  if (currentLevel <= 1) {
    if (_workerPost) return _workerPost({ type: 'log', level: 'info', component, message });
    console.log(`${ts()} INFO  [${component}] ${message}`);
    _webuiLog?.('info', component, message);
  }
}

export function warn(component: string, message: string): void {
  if (currentLevel <= 2) {
    if (_workerPost) return _workerPost({ type: 'log', level: 'warn', component, message });
    console.warn(`${ts()} WARN  [${component}] ${message}`);
    _webuiLog?.('warn', component, message);
  }
}

export function error(component: string, message: string): void {
  if (currentLevel <= 3) {
    if (_workerPost) return _workerPost({ type: 'log', level: 'error', component, message });
    console.error(`${ts()} ERROR [${component}] ${message}`);
    _webuiLog?.('error', component, message);
  }
}

export function log(level: LogLevel, component: string, message: string): void {
  if (level === 'debug') debug(component, message);
  else if (level === 'info') info(component, message);
  else if (level === 'warn') warn(component, message);
  else error(component, message);
}
