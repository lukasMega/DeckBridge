// The page's one WebSocket: hello, ping/ack, reconnect with backoff, and the rule that input is
// only ever sent on a live socket and never queued (a reconnect can not replay a press).
import type { DeckByeReason, DeckLayout, DeckServerMsg } from '../../contract-deck.js';
import { decodeDeckFrame, type DeckFrame } from './frame-decode.js';

/** `hello.v` must match the server's DECK_PROTOCOL_VERSION. */
export const PROTOCOL_VERSION = 1;
const PING_INTERVAL_MS = 1000;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 5000;
const JITTER = 0.2;
const RTT_SAMPLES = 60;
const OPEN = 1;

/** The slice of WebSocket used here, so tests inject a fake. */
export interface SocketLike {
  readyState: number;
  binaryType: string;
  send(data: string): void;
  close(): void;
  addEventListener(type: SocketEvent, listener: (ev: { data?: unknown }) => void): void;
  removeEventListener(type: SocketEvent, listener: (ev: { data?: unknown }) => void): void;
}

export type SocketEvent = 'open' | 'message' | 'close' | 'error';

export type ConnState = 'connecting' | 'live' | 'reconnecting' | 'stopped';

export interface DeckWelcome {
  layout: DeckLayout;
  brightness: number;
  paired: boolean;
  deviceName: string;
}

export interface DeckSocketOptions {
  url: string;
  token: string;
  clientId: string;
  name?: string;
  createSocket: (url: string) => SocketLike;
  now?: () => number;
  onState: (state: ConnState) => void;
  /** Open fired: the page must visually release every key before `hello` goes out. */
  onReset: () => void;
  onWelcome: (w: DeckWelcome) => void;
  onFrame: (f: DeckFrame) => void;
  onClear: (key: number) => void;
  onBrightness: (level: number) => void;
  onPaired: (value: boolean) => void;
  /** Server closed us for a reason the page must act on (credential gone, protocol mismatch). */
  onBye: (reason: DeckByeReason) => void;
}

/** Reasons after which retrying cannot help; the page shows the pair screen or an error. */
const TERMINAL: readonly DeckByeReason[] = ['unauthorized', 'revoked', 'upgrade'];

export function randomClientId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += (bytes[i]! + 256).toString(16).slice(1);
  return out;
}

// Jitter only spreads reconnects; it needs no unpredictability.
// eslint-disable-next-line sonarjs/pseudo-random
export function backoffDelay(attempt: number, random: number = Math.random()): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * Math.pow(2, attempt));
  return Math.round(base * (1 + (random * 2 - 1) * JITTER));
}

export class DeckSocket {
  private sock: SocketLike | null = null;
  private detach: (() => void) | null = null;
  private live = false;
  private suspended = false;
  private stopped = false;
  private frames = 0;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private readonly rtts: number[] = [];
  private readonly now: () => number;

  constructor(private readonly o: DeckSocketOptions) {
    this.now = o.now ?? ((): number => performance.now());
  }

  connect(): void {
    if (this.stopped || this.suspended || this.sock) return;
    this.o.onState(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const sock = this.o.createSocket(this.o.url);
    this.sock = sock;
    sock.binaryType = 'arraybuffer';
    this.attach(sock);
  }

  private attach(sock: SocketLike): void {
    const handlers: Array<[SocketEvent, (ev: { data?: unknown }) => void]> = [
      ['open', () => this.onOpen()],
      ['message', (ev) => this.onMessage(ev.data)],
      ['error', () => undefined], // close always follows
      ['close', () => this.onClose(sock)],
    ];
    for (const [type, fn] of handlers) sock.addEventListener(type, fn);
    this.detach = (): void => {
      for (const [type, fn] of handlers) sock.removeEventListener(type, fn);
    };
  }

  private onOpen(): void {
    this.frames = 0; // the server's ack window is per connection
    this.o.onReset();
    this.sendRaw({
      t: 'hello',
      v: PROTOCOL_VERSION,
      token: this.o.token,
      clientId: this.o.clientId,
      now: this.now(),
      ...(this.o.name ? { name: this.o.name } : {}),
    });
  }

  /** True when the key message was sent; a press on a dead socket is dropped, never queued. */
  sendKey(k: number, s: 'down' | 'up'): boolean {
    if (!this.live) return false;
    return this.sendRaw({ t: 'key', k, s, now: this.now() });
  }

  /** Page hidden / blurred: release everything server-side and go quiet until `resume`. */
  suspend(): void {
    this.suspended = true;
    clearTimeout(this.reconnectTimer);
    if (this.live) this.sendRaw({ t: 'releaseAll', now: this.now() });
    this.closeSocket();
    this.o.onState('reconnecting');
  }

  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    this.attempt = 0;
    this.connect();
  }

  /** Network came back: skip the backoff wait. */
  retryNow(): void {
    if (this.suspended || this.stopped || this.sock) return;
    clearTimeout(this.reconnectTimer);
    this.attempt = 0;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.closeSocket();
    this.o.onState('stopped');
  }

  /** Round-trip stats over the last RTT_SAMPLES pings, for the `?debug=1` overlay. */
  rtt(): { p50: number; p95: number } | null {
    if (this.rtts.length === 0) return null;
    // toSorted is newer than the oldest supported Safari (build.mjs legacy denylist).
    // oxlint-disable-next-line unicorn/no-array-sort -- legacy bundle, see above
    const sorted = this.rtts.slice().sort((a, b) => a - b);
    const at = (p: number): number =>
      sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
    return { p50: at(0.5), p95: at(0.95) };
  }

  get inFlightFrames(): number {
    return this.frames;
  }

  private sendRaw(msg: object): boolean {
    if (!this.sock || this.sock.readyState !== OPEN) return false;
    try {
      this.sock.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  private onMessage(data: unknown): void {
    if (typeof data === 'string') {
      let msg: DeckServerMsg;
      try {
        msg = JSON.parse(data) as DeckServerMsg;
      } catch {
        return;
      }
      this.onText(msg);
      return;
    }
    if (data instanceof ArrayBuffer) {
      // Ack before decode: the ack frees the server's window, decode is local work.
      this.frames++;
      this.sendRaw({ t: 'ack', n: this.frames });
      const frame = decodeDeckFrame(data);
      if (frame) this.o.onFrame(frame);
    }
  }

  private onText(msg: DeckServerMsg): void {
    switch (msg.t) {
      case 'welcome':
        this.live = true;
        this.attempt = 0;
        this.o.onState('live');
        this.o.onWelcome({
          layout: msg.layout,
          brightness: msg.brightness,
          paired: msg.paired,
          deviceName: msg.deviceName,
        });
        this.startPing();
        break;
      case 'pong':
        this.rtts.push(this.now() - msg.now);
        if (this.rtts.length > RTT_SAMPLES) this.rtts.shift();
        break;
      case 'brightness':
        this.o.onBrightness(msg.level);
        break;
      case 'paired':
        this.o.onPaired(msg.value);
        break;
      case 'clear':
        this.o.onClear(msg.k);
        break;
      case 'bye':
        if (TERMINAL.includes(msg.reason)) this.stopped = true;
        this.o.onBye(msg.reason);
        break;
    }
  }

  private startPing(): void {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      this.sendRaw({ t: 'ping', now: this.now() });
    }, PING_INTERVAL_MS);
  }

  private closeSocket(): void {
    clearInterval(this.pingTimer);
    this.live = false;
    const sock = this.sock;
    this.sock = null;
    this.detach?.();
    this.detach = null;
    if (!sock) return;
    try {
      sock.close();
    } catch {
      // already closed
    }
  }

  private onClose(sock: SocketLike): void {
    if (this.sock !== sock) return;
    this.closeSocket();
    if (this.stopped || this.suspended) {
      if (this.stopped) this.o.onState('stopped');
      return;
    }
    this.o.onState('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.attempt++;
      this.connect();
    }, backoffDelay(this.attempt));
  }
}
