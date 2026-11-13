// Scriptable stand-in for the browser WebSocket, shared by the deck page tests.
import type { SocketEvent, SocketLike } from '../../src/web/client/deck/deck-socket.js';

type Listener = (ev: { data?: unknown }) => void;

export class FakeDeckSocket implements SocketLike {
  readyState = 0;
  binaryType = '';
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  private readonly listeners = new Map<SocketEvent, Listener[]>();

  addEventListener(type: SocketEvent, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: SocketEvent, listener: Listener): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => l !== listener),
    );
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  private emit(type: SocketEvent, ev: { data?: unknown } = {}): void {
    for (const l of this.listeners.get(type) ?? []) l(ev);
  }

  open(): void {
    this.readyState = 1;
    this.emit('open');
  }

  /** The server went away without a `bye`. */
  drop(): void {
    this.emit('close');
  }

  text(msg: object): void {
    this.emit('message', { data: JSON.stringify(msg) });
  }

  binary(data: ArrayBuffer | number[]): void {
    this.emit('message', { data: Array.isArray(data) ? new Uint8Array(data).buffer : data });
  }

  keys(): string[] {
    return this.sent.filter((m) => m.t === 'key').map((m) => `${String(m.k)}:${String(m.s)}`);
  }
}
