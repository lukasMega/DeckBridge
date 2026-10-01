// Admin side of the browser deck: config, pairing offers, device list, revoke. The runtime
// (listener + hub) is attached by main/virtual-deck once the dock exists; this class never
// starts anything itself.
import { isBrowserDeckProfile } from '../../../devices/virtual/browser-deck-profiles.js';
import {
  CORA_PORT_STRIDE,
  ELGATO_CHILD_PORT,
  ELGATO_TCP_PORT,
  VIRTUAL_DOCK_INDEX,
  bindAddr,
  deckPort,
} from '../../../shared/types.js';
import type { PairingOffer, VirtualDeckState } from '../../contract-deck.js';
import type { PushController } from '../push-controller.js';
import type { ControllerHost, ReqError } from '../types.js';
import { ownInterfaceAddresses } from '../web-request-guard.js';
import { DeckAuth } from './deck-auth.js';
import type { DeckHub } from './deck-hub.js';
import type { DeckServer } from './deck-server.js';
import { PairingCodes } from './pairing-codes.js';

export interface VirtualDeckRuntime {
  server: DeckServer;
  hub: DeckHub;
}

const PRIVATE_RANGE = /^(?:192\.168\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

/** Private-range addresses first: the one a phone on the same Wi-Fi can reach. */
export function lanAddresses(): string[] {
  const all = ownInterfaceAddresses();
  return [
    ...all.filter((a) => PRIVATE_RANGE.test(a)),
    ...all.filter((a) => !PRIVATE_RANGE.test(a)),
  ];
}

export class VirtualDeckController {
  readonly auth: DeckAuth;
  runtime: VirtualDeckRuntime | null = null;
  /** Why the last start failed (bind error), shown in the panel. */
  lastError: string | undefined;
  private readonly codes = new PairingCodes();

  constructor(
    private readonly host: ControllerHost,
    private readonly push: PushController,
    private readonly now: () => number = Date.now,
  ) {
    this.auth = new DeckAuth(push, push.limits, this.codes, now);
  }

  /** The failed-auth throttle shared with the push API (per remote address). */
  get limits(): PushController['limits'] {
    return this.push.limits;
  }

  state(): VirtualDeckState {
    const { enabled, profile } = this.host.settings.virtualDeck;
    const port = deckPort();
    const connected = new Set(this.runtime?.hub.clients().map((c) => c.tokenId));
    const hub = this.runtime?.hub;
    const p95 = hub && hub.latency().count > 0 ? hub.latency().p95() : undefined;
    const pending = this.codes.pending(this.now());
    const error = this.runtime?.server.lastError ?? this.lastError;
    const primary = ELGATO_TCP_PORT + CORA_PORT_STRIDE * VIRTUAL_DOCK_INDEX;
    return {
      enabled,
      profile,
      listening: this.runtime?.server.listening ?? false,
      port,
      bindLoopbackOnly: bindAddr().startsWith('127.'),
      ...(error ? { lastError: error } : {}),
      urls: this.urls(port),
      devices: this.auth.devices(connected),
      ...(pending ? { pending: { expiresAt: pending.expiresAt } } : {}),
      ...(p95 !== undefined ? { latencyP95Ms: Math.round(p95) } : {}),
      coraPorts: {
        primary,
        child: ELGATO_CHILD_PORT + CORA_PORT_STRIDE * VIRTUAL_DOCK_INDEX,
      },
    };
  }

  setConfig(body: { enabled?: unknown; profile?: unknown }): VirtualDeckState | ReqError {
    const cur = this.host.settings.virtualDeck;
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      return { status: 400, error: 'enabled must be a boolean' };
    }
    if (body.profile !== undefined && !isBrowserDeckProfile(body.profile)) {
      return { status: 400, error: 'unknown profile' };
    }
    this.host.settings.setVirtualDeck({
      enabled: body.enabled ?? cur.enabled,
      profile: (body.profile as string | undefined) ?? cur.profile,
    });
    this.host.emit('virtualDeckChanged');
    return this.state();
  }

  createPairing(): PairingOffer | ReqError {
    if (!this.runtime?.server.listening) {
      return { status: 409, error: 'the browser deck is not running' };
    }
    const code = this.codes.create(this.now());
    const port = deckPort();
    const urls = this.urls(port);
    const base = urls[0] ?? `http://127.0.0.1:${port}/deck/`;
    return {
      shortCode: code.shortCode,
      qrUrl: `${base}#pair=${code.code}`,
      urls,
      expiresAt: code.expiresAt,
    };
  }

  cancelPairing(): void {
    this.codes.cancel();
  }

  revoke(id: string): ReqError | null {
    const record = this.host.settings.accessTokenRecords().find((r) => r.id === id);
    if (!record?.scopes.includes('deck')) return { status: 404, error: 'no such device' };
    return this.push.revokeToken(id);
  }

  revokeAll(): number {
    const ids = this.host.settings
      .accessTokenRecords()
      .filter((r) => r.scopes.includes('deck'))
      .map((r) => r.id);
    for (const id of ids) this.push.revokeToken(id);
    return ids.length;
  }

  private urls(port: number): string[] {
    return lanAddresses().map((ip) => `http://${ip}:${port}/deck/`);
  }
}
