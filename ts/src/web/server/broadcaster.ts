import { SSE_KEEPALIVE_INTERVAL_MS, STATS_BROADCAST_INTERVAL_MS } from '../../types.js';

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
    }, SSE_KEEPALIVE_INTERVAL_MS);
    this.statsTimer = setInterval(emitStats, STATS_BROADCAST_INTERVAL_MS);
  }

  stop(): void {
    if (this.keepaliveTimer !== null) clearInterval(this.keepaliveTimer);
    if (this.statsTimer !== null) clearInterval(this.statsTimer);
    this.keepaliveTimer = null;
    this.statsTimer = null;
    for (const ws of this.clients) {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
    this.clients.clear();
  }

  broadcast(event: string, data: unknown): void {
    this.send(wsMsg(event, data));
  }

  sendTo(ws: ServerWebSocket, event: string, data: unknown): void {
    ws.sendText(wsMsg(event, data));
  }

  private send(msg: string): void {
    for (const ws of this.clients) {
      try {
        ws.sendText(msg);
      } catch {
        this.clients.delete(ws);
      }
    }
  }
}
