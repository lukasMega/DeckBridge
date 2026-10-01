import { clearRepeating } from '../../shared/types.js';
import { WS_KEEPALIVE_INTERVAL_MS, STATS_BROADCAST_INTERVAL_MS } from './constants.js';
import type { WsEvents } from '../contract.js';

/** A browser that lets this much queue up is stalled; dropping it beats unbounded growth. */
export const WS_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

function wsMsg(event: string, data: unknown): string {
  return JSON.stringify({ event, data });
}

/**
 * Owns the set of connected WebSocket clients and the broadcast timers.
 * The server is broadcast-only; clients never send meaningful messages.
 */
export class Broadcaster {
  private readonly clients = new Set<ServerWebSocket>();
  private keepaliveTimer: number | null = null;
  private statsTimer: number | null = null;

  /** Number of currently connected WS clients. */
  get size(): number {
    return this.clients.size;
  }

  /** Build the `websocket` handler object for `tjs.serve`; `onOpen` fires after a client joins. */
  websocketHandlers(onOpen: (ws: ServerWebSocket) => void) {
    return {
      open: (ws: ServerWebSocket) => {
        this.clients.add(ws);
        onOpen(ws);
      },
      message: () => {
        /* server is broadcast-only; required by txiki.js or upgrade is rejected */
      },
      close: (ws: ServerWebSocket) => {
        this.clients.delete(ws);
      },
      error: (ws: ServerWebSocket) => {
        this.clients.delete(ws);
      },
    };
  }

  /** Start the keepalive ping and the periodic stats tick (`emitStats` runs on each interval). */
  start(emitStats: () => void): void {
    this.keepaliveTimer = setInterval(() => {
      this.send(wsMsg('ping', null));
    }, WS_KEEPALIVE_INTERVAL_MS);
    this.statsTimer = setInterval(emitStats, STATS_BROADCAST_INTERVAL_MS);
  }

  stop(): void {
    this.keepaliveTimer = clearRepeating(this.keepaliveTimer);
    this.statsTimer = clearRepeating(this.statsTimer);
    for (const ws of this.clients) {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
    this.clients.clear();
  }

  broadcast<K extends keyof WsEvents>(event: K, data: WsEvents[K]): void {
    // Skip the JSON.stringify, not just the send loop: with no browser open,
    // ActivityBuffers.flush() serialized up to 500 comm entries every 100 ms for
    // nothing. sendTo() is unaffected — it targets a socket that exists.
    if (this.clients.size === 0) return;
    this.send(wsMsg(event, data));
  }

  sendTo<K extends keyof WsEvents>(ws: ServerWebSocket, event: K, data: WsEvents[K]): void {
    ws.sendText(wsMsg(event, data));
  }

  private send(msg: string): void {
    for (const ws of this.clients) {
      try {
        if ((ws.bufferedAmount ?? 0) > WS_MAX_BUFFERED_BYTES) {
          this.clients.delete(ws);
          ws.close(1013, 'client too slow');
          continue;
        }
        ws.sendText(msg);
      } catch {
        this.clients.delete(ws);
      }
    }
  }
}
