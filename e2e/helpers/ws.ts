/**
 * The app's /api/ws channel, read from Node rather than the page: it keeps the round-trip
 * checks off Lightpanda (whose sessions degrade after many page-side requests) and needs
 * no navigation. Wire format is `{ event, data }` (ts/src/web/server/broadcaster.ts).
 */
export interface WsFrame {
  event: string;
  data: Record<string, unknown>;
}

/**
 * Open the channel, run `trigger` once it is open, and resolve with the first frame that
 * matches `match` (the initial `status` snapshot is skipped unless it matches).
 */
export function nextFrame(
  baseURL: string,
  match: (frame: WsFrame) => boolean,
  trigger: () => Promise<unknown>,
  timeoutMs = 10_000,
): Promise<WsFrame> {
  const ws = new WebSocket(`${baseURL.replace(/^http/, 'ws')}/api/ws`);
  return new Promise<WsFrame>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`no matching /api/ws frame within ${timeoutMs}ms`));
    }, timeoutMs);
    ws.addEventListener('open', () => {
      trigger().catch((err: unknown) => {
        clearTimeout(timer);
        ws.close();
        reject(err as Error);
      });
    });
    ws.addEventListener('message', (ev) => {
      const frame = JSON.parse(String(ev.data)) as WsFrame;
      if (!match(frame)) return;
      clearTimeout(timer);
      ws.close();
      resolve(frame);
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('websocket error'));
    });
  });
}
