/** Extension worker message protocol: the only messages between the main thread
 *  (extension-host.ts) and one extension's worker (extension-worker.ts). */
import type { LogLevel } from '../shared/logger.js';
import type { ExtensionEvent, ExtensionRequest } from './api.js';

/** Longest JSON reply text; the worker checks it, the host checks again. */
export const MAX_REPLY_CHARS = 256 * 1024;

export type MainToExtensionWorker =
  /** `path` is the ABSOLUTE path of server.js, never a file:// URL (see plugin-worker.ts). */
  | { type: 'load'; id: string; path: string; appStartedAt: number }
  | { type: 'events'; events: ExtensionEvent[] }
  | ({ type: 'request'; reqId: number } & ExtensionRequest)
  | { type: 'ping'; seq: number };

export type ExtensionWorkerToMain =
  | { type: 'loaded' }
  | { type: 'loadError'; message: string }
  | { type: 'response'; reqId: number; status: number; json: string }
  | { type: 'pong'; seq: number }
  | { type: 'log'; level: LogLevel; message: string };
