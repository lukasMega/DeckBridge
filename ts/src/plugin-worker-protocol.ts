/** Plugin Worker message protocol. User plugin JS runs in a dedicated Worker
 *  for crash/CPU isolation from the CORA ACK loop; these are the only messages
 *  that cross the boundary. See plugin-host.ts (main side) / plugin-worker.ts. */
import type { LogLevel } from './logger.js';

/** One plugin key the worker should poll. `key` is the host's cache identity
 *  (plugin file + arg); `path` is the ABSOLUTE on-disk path to import — never a
 *  file:// URL, never relative (Phase 0 spike: only a plain path imports). */
export interface PluginRunConfig {
  key: string;
  path: string;
  param: string;
  intervalMs?: number;
}

/** Minimal fetch init a plugin may pass to ctx.fetch. The worker can NEVER call
 *  the global fetch (it SIGABRTs the whole process — Phase 0 S2), so every
 *  request is proxied to the main thread and run there. */
export interface PluginFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export type MainToPluginWorker =
  | { type: 'configure'; plugins: PluginRunConfig[] }
  | {
      type: 'fetchResult';
      fetchId: number;
      ok: boolean;
      status: number;
      body: string;
      error?: string;
    }
  | { type: 'ping'; seq: number };

export type PluginWorkerToMain =
  // One poll produced a value: string → textLines(); null → clear the key.
  | { type: 'value'; key: string; value: string | null }
  // Plugin threw (load or poll) — host marks the key ERR + warn-logs.
  | { type: 'error'; key: string; message: string }
  // ctx.fetch proxy: the worker asks the main thread to run a real fetch.
  | { type: 'fetch'; fetchId: number; url: string; init?: PluginFetchInit }
  | { type: 'pong'; seq: number }
  // ctx.log — routed through the main logger with a plugin-name component.
  | { type: 'log'; level: LogLevel; component: string; message: string };
