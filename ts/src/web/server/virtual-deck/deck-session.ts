// One browser page's connection state. Logic that spans sessions lives in DeckHub.
import type { DeckServerMsg } from '../../contract-deck.js';
import { DECK_MAX_IN_FLIGHT, DECK_MAX_MSGS_PER_S } from './deck-constants.js';
import { FrameQueue, type QueueItem } from './frame-queue.js';
import { InputFreshness } from './input-freshness.js';

/** The slice of tjs's ServerWebSocket the hub uses (fakes implement it in tests). */
export interface DeckSocket {
  sendText(data: string): void;
  sendBinary(data: Uint8Array): void;
  close(): void;
}

export type SessionState = 'awaiting-hello' | 'authenticating' | 'live' | 'closed';

export class DeckSession {
  state: SessionState = 'awaiting-hello';
  tokenId = '';
  clientId = '';
  deviceName = '';
  lastRxAt: number;
  readonly freshness = new InputFreshness();
  readonly queue: FrameQueue;
  private windowStart: number;
  private windowCount = 0;

  constructor(
    readonly id: string,
    readonly ws: DeckSocket,
    readonly remoteAddress: string,
    readonly openedAt: number,
  ) {
    this.lastRxAt = openedAt;
    this.windowStart = openedAt;
    this.queue = new FrameQueue(DECK_MAX_IN_FLIGHT, (item) => this.writeItem(item));
  }

  /** False once the session exceeded its message budget for the current second. */
  allowMessage(now: number): boolean {
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    return ++this.windowCount <= DECK_MAX_MSGS_PER_S;
  }

  send(msg: DeckServerMsg): void {
    this.ws.sendText(JSON.stringify(msg));
  }

  private writeItem(item: QueueItem): void {
    if (item.kind === 'frame') this.ws.sendBinary(item.bytes);
    else this.send({ t: 'clear', k: item.key });
  }
}
