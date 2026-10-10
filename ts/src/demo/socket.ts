import type { WsEvents } from '../web/contract.js';

type Listener = (event: Event | MessageEvent<string>) => void;

export class FakeSocket {
  private listeners = new Map<string, Listener[]>();
  private closed = false;

  constructor() {
    setTimeout(() => {
      if (!this.closed) this.dispatch('open', new Event('open'));
    }, 0);
  }

  addEventListener(type: 'open' | 'close' | 'error', fn: (event: Event) => void): void;
  addEventListener(type: 'message', fn: (event: MessageEvent<string>) => void): void;
  addEventListener(type: string, fn: Listener | ((event: MessageEvent<string>) => void)): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(fn as Listener);
    this.listeners.set(type, listeners);
  }

  private dispatch(type: string, event: Event | MessageEvent<string>): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  send<K extends keyof WsEvents>(event: K, data: WsEvents[K]): void {
    if (!this.closed)
      this.dispatch('message', { data: JSON.stringify({ event, data }) } as MessageEvent<string>);
  }

  close(): void {
    // A close event would make the client reconnect forever.
    this.closed = true;
    this.listeners.clear();
  }
}
