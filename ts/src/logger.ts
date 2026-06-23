declare const __LOG_LEVEL__: number;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

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
  if (__LOG_LEVEL__ <= 0) {
    if (_workerPost) return _workerPost({ type: 'log', level: 'debug', component, message });
    console.debug(`${ts()} DEBUG [${component}] ${message}`);
    _webuiLog?.('debug', component, message);
  }
}

export function info(component: string, message: string): void {
  if (__LOG_LEVEL__ <= 1) {
    if (_workerPost) return _workerPost({ type: 'log', level: 'info', component, message });
    console.log(`${ts()} INFO  [${component}] ${message}`);
    _webuiLog?.('info', component, message);
  }
}

export function warn(component: string, message: string): void {
  if (__LOG_LEVEL__ <= 2) {
    if (_workerPost) return _workerPost({ type: 'log', level: 'warn', component, message });
    console.warn(`${ts()} WARN  [${component}] ${message}`);
    _webuiLog?.('warn', component, message);
  }
}

export function error(component: string, message: string): void {
  if (__LOG_LEVEL__ <= 3) {
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
