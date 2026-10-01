// All connected browser pages: handshake, key transitions toward the dock, image/brightness
// fan-out. Pure of I/O (sockets and the dock are injected) so the whole policy is testable.
import type { KeyState } from '../../../shared/types.js';
import type { DeckByeReason, DeckLayout } from '../../contract-deck.js';

export type { DeckByeReason, DeckLayout };
import type { PushRateLimits } from '../push-rate-limit.js';
import {
  DECK_HELLO_TIMEOUT_MS,
  DECK_LIVENESS_TIMEOUT_MS,
  DECK_MAX_CLIENTS,
  DECK_MAX_DOWN_LATENESS_MS,
  DECK_PROTOCOL_VERSION,
} from './deck-constants.js';
import { parseDeckClientMsg } from './deck-messages.js';
import { DeckSession, type DeckSocket } from './deck-session.js';
import { encodeDeckFrame } from './frame-codec.js';
import { HeldKeys } from './held-keys.js';
import { LatencyWindow } from './input-freshness.js';

/** Unauthenticated sockets waiting for `hello`; bounded so they cannot starve live pages. */
const MAX_UNAUTHENTICATED = 16;

/** What the hub reads from, and drives on, the browser deck's dock. */
export interface DeckSource {
  layout(): DeckLayout;
  snapshot(): Iterable<[number, { data: Uint8Array; format: 'jpeg' | 'bmp' }]>;
  brightness(): number;
  elgatoPaired(): boolean;
  input(key: number, state: KeyState): void;
}

export interface DeckHubAuth {
  verify(token: string): Promise<{ id: string; name: string } | null>;
  noteSeen(id: string): void;
}

export interface DeckHubDeps {
  source: DeckSource;
  auth: DeckHubAuth;
  limits: Pick<PushRateLimits, 'checkFailedAuth' | 'noteFailedAuth'>;
  now?: () => number;
  log?: (level: 'debug' | 'info' | 'warn', message: string) => void;
}

export interface DeckClientInfo {
  id: string;
  tokenId: string;
  since: number;
}

export class DeckHub {
  onClientsChanged: () => void = () => {};
  private readonly sessions = new Map<DeckSocket, DeckSession>();
  private readonly held = new HeldKeys();
  private readonly latencies = new LatencyWindow();
  private readonly now: () => number;
  private readonly log: NonNullable<DeckHubDeps['log']>;
  private nextId = 1;

  constructor(private readonly deps: DeckHubDeps) {
    this.now = deps.now ?? ((): number => performance.now());
    this.log = deps.log ?? ((): void => {});
  }

  latency(): LatencyWindow {
    return this.latencies;
  }

  clients(): DeckClientInfo[] {
    return this.live().map((s) => ({ id: s.clientId, tokenId: s.tokenId, since: s.openedAt }));
  }

  open(ws: DeckSocket, remoteAddress: string): void {
    const waiting = [...this.sessions.values()].filter((s) => s.state !== 'live').length;
    const session = new DeckSession(`s${this.nextId++}`, ws, remoteAddress, this.now());
    if (waiting >= MAX_UNAUTHENTICATED) {
      this.bye(session, 'full');
      return;
    }
    this.sessions.set(ws, session);
  }

  message(ws: DeckSocket, text: string): void {
    const s = this.sessions.get(ws);
    if (!s || s.state === 'closed') return;
    const now = this.now();
    s.lastRxAt = now;
    if (!s.allowMessage(now)) return this.bye(s, 'protocol');
    const msg = parseDeckClientMsg(text);
    if (!msg) return this.bye(s, 'protocol');
    if (s.state === 'authenticating') return; // the client sends nothing before `welcome`
    if (s.state === 'awaiting-hello') {
      if (msg.t !== 'hello') return this.bye(s, 'protocol');
      s.state = 'authenticating';
      void this.hello(s, msg.v, msg.token, msg.clientId, msg.now, msg.name);
      return;
    }
    switch (msg.t) {
      case 'hello':
        return this.bye(s, 'protocol');
      case 'ping':
        s.freshness.sample(msg.now, now);
        return s.send({ t: 'pong', now: msg.now });
      case 'ack':
        return s.queue.ack(msg.n);
      case 'releaseAll':
        s.freshness.sample(msg.now, now);
        return this.release(s);
      case 'key':
        return this.key(s, msg.k, msg.s, msg.now, now);
    }
  }

  close(ws: DeckSocket): void {
    const s = this.sessions.get(ws);
    if (s) this.drop(s);
  }

  /** A CORA image for `key` (or its removal): fan out to every live page. */
  frame(key: number, data: Uint8Array, format: 'jpeg' | 'bmp'): void {
    const bytes = encodeDeckFrame(key, data, format); // one encode shared by all pages
    for (const s of this.live()) s.queue.push({ kind: 'frame', key, bytes });
  }

  clear(key: number): void {
    for (const s of this.live()) s.queue.push({ kind: 'clear', key });
  }

  brightness(level: number): void {
    for (const s of this.live()) s.send({ t: 'brightness', level });
  }

  paired(value: boolean): void {
    for (const s of this.live()) s.send({ t: 'paired', value });
  }

  /** Close every page using this token (revoke). */
  kick(tokenId: string, reason: DeckByeReason): void {
    for (const s of this.sessions.values()) if (s.tokenId === tokenId) this.bye(s, reason);
  }

  closeAll(reason: DeckByeReason): void {
    for (const s of this.sessions.values()) this.bye(s, reason);
  }

  /** Called every DECK_TICK_MS: hello timeout and liveness (a sleeping phone stops pinging). */
  tick(now: number = this.now()): void {
    for (const s of this.sessions.values()) {
      const limit = s.state === 'live' ? DECK_LIVENESS_TIMEOUT_MS : DECK_HELLO_TIMEOUT_MS;
      const since = s.state === 'live' ? s.lastRxAt : s.openedAt;
      if (now - since > limit) this.bye(s, 'timeout');
    }
  }

  private live(): DeckSession[] {
    return [...this.sessions.values()].filter((s) => s.state === 'live');
  }

  private async hello(
    s: DeckSession,
    version: number,
    token: string,
    clientId: string,
    clientNow: number,
    name: string | undefined,
  ): Promise<void> {
    if (version !== DECK_PROTOCOL_VERSION) return this.bye(s, 'upgrade');
    if (this.deps.limits.checkFailedAuth(s.remoteAddress) > 0) return this.bye(s, 'unauthorized');
    const who = await this.deps.auth.verify(token);
    if (s.state !== 'authenticating') return; // closed while verifying
    if (!who) {
      this.deps.limits.noteFailedAuth(s.remoteAddress);
      return this.bye(s, 'unauthorized');
    }
    if (this.live().length >= DECK_MAX_CLIENTS) return this.bye(s, 'full');
    s.state = 'live';
    s.tokenId = who.id;
    s.clientId = clientId;
    s.deviceName = name ?? who.name;
    s.freshness.sample(clientNow, this.now());
    this.deps.auth.noteSeen(who.id);
    const src = this.deps.source;
    s.send({
      t: 'welcome',
      v: DECK_PROTOCOL_VERSION,
      layout: src.layout(),
      brightness: src.brightness(),
      paired: src.elgatoPaired(),
      deviceName: s.deviceName,
    });
    const snapshot = [...src.snapshot()].toSorted((a, b) => a[0] - b[0]);
    for (const [key, { data, format }] of snapshot) {
      s.queue.push({ kind: 'frame', key, bytes: encodeDeckFrame(key, data, format) });
    }
    this.onClientsChanged();
  }

  private key(s: DeckSession, k: number, state: KeyState, clientNow: number, now: number): void {
    if (k >= this.deps.source.layout().keyCount) return this.bye(s, 'protocol');
    if (state === 'up') {
      s.freshness.sample(clientNow, now);
      if (this.held.up(s.id, k)) this.deps.source.input(k, 'up'); // an up for a key not held is ignored
      return;
    }
    const lateness = s.freshness.lateness(clientNow, now);
    s.freshness.sample(clientNow, now);
    if (lateness > DECK_MAX_DOWN_LATENESS_MS) {
      this.log('info', `stale press dropped: k=${k} late=${Math.round(lateness)}ms`);
      return;
    }
    this.latencies.add(lateness);
    if (this.held.down(s.id, k)) this.deps.source.input(k, 'down');
  }

  private release(s: DeckSession): void {
    for (const key of this.held.releaseSession(s.id)) this.deps.source.input(key, 'up');
  }

  /** Tell the page why, then close; custom close codes do not survive tjs, `bye` does. */
  private bye(s: DeckSession, reason: DeckByeReason): void {
    if (s.state === 'closed') return;
    try {
      s.send({ t: 'bye', reason });
    } catch {
      // socket already gone
    }
    this.drop(s);
    try {
      s.ws.close();
    } catch {
      // already closed
    }
  }

  private drop(s: DeckSession): void {
    if (s.state === 'closed') return;
    const wasLive = s.state === 'live';
    s.state = 'closed';
    this.sessions.delete(s.ws);
    this.release(s);
    if (wasLive) this.onClientsChanged();
  }
}
