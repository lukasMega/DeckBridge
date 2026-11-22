// State of the pairing route (issue #257): which workaround this install uses against Stream
// Deck app 7.6.1+ refusing a dock at its own IP. Pure over injected deps so the sequencing
// (persist, WSL relay, mDNS) is tested with fakes; main/pairing-route-wiring.ts builds the real one.
import type {
  PairingRoute,
  PairingRouteStatus,
  RelayEventBody,
  RelayProgress,
} from '../web/contract-pairing-route.js';
import type { WslRelayStatus } from '../web/contract-wsl-relay.js';
import type { PairingRouteSettings } from './settings-store.js';

/** Routes where a relay dials DeckBridge, so mDNS must not hand the app DeckBridge's own IP. */
export function isRelayRoute(r: PairingRoute): boolean {
  return r === 'wsl' || r === 'device' || r === 'container' || r === 'orbstack';
}

/** Routes whose relay the install script starts and reports on. */
export function isScriptRoute(r: PairingRoute): boolean {
  return r === 'device' || r === 'orbstack' || r === 'container';
}

/** A silent relay is shown as offline (the script heartbeats every 30 s) and a stalled install as
 *  failed, so the wizard never spins forever on a dead device. */
export const RUNNING_STALE_MS = 90_000;
export const INSTALL_STALE_MS = 120_000;

export type RelayEvent = Omit<RelayEventBody, 't'>;

export interface PairingRouteDeps {
  /** False where no route can work (Linux): nothing is spawned or read. */
  supported: boolean;
  /** DeckBridge's version (`__VERSION__`). */
  version: string;
  settings: {
    readonly pairingRoute: PairingRouteSettings;
    setPairingRoute(v: PairingRouteSettings): void;
  };
  wsl: {
    setEnabled(on: boolean): Promise<WslRelayStatus>;
    status(): WslRelayStatus;
  };
  applyMdns(relayOn: boolean): void;
  readElgatoVersion(): Promise<string | undefined>;
  paired(): boolean;
  onStatus(s: PairingRouteStatus): void;
  /** 32 hex chars from a CSPRNG. */
  newToken(): string;
  now(): number;
}

export class PairingRouteState {
  private elgatoVersion: string | null = null;
  /** Only to publish on a change; `status()` reads the live values. */
  private lastPaired = false;
  private lastWslIp: string | null = null;
  /** Live script-relay state; memory only, a restart starts from "no relay seen". */
  private relay: RelayProgress | null = null;
  private staleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: PairingRouteDeps) {}

  status(): PairingRouteStatus {
    const { supported, settings, wsl } = this.deps;
    const { route, relayIp, wizardDismissed } = settings.pairingRoute;
    const relay = this.liveRelay();
    return {
      supported,
      route,
      elgatoVersion: this.elgatoVersion,
      relayIp: route === 'wsl' ? wsl.status().wslIp : (relayIp ?? relay?.ip ?? null),
      relayVersion: relay?.version ?? null,
      versionMismatch: relay !== null && relay.version !== this.deps.version.replace(/^v/, ''),
      announcedAt: relay?.at ?? null,
      relay,
      paired: this.deps.paired(),
      wizardDismissed: wizardDismissed === true,
    };
  }

  async setRoute(r: PairingRoute): Promise<PairingRouteStatus> {
    const { supported, settings, wsl } = this.deps;
    const from = settings.pairingRoute.route;
    if (!supported || r === from) return this.status();
    const next: PairingRouteSettings = { ...settings.pairingRoute, route: r };
    // The reporting relay belongs to the old route.
    delete next.relayIp;
    this.relay = null;
    this.clearStaleTimer();
    // Kept across route changes: an autostarted relay keeps its URL.
    if (isScriptRoute(r)) next.token ??= this.deps.newToken();
    settings.setPairingRoute(next);
    if (from === 'wsl') await wsl.setEnabled(false);
    // A newer setRoute ran during the await and owns the relay and mDNS now.
    if (settings.pairingRoute.route !== r) return this.status();
    // Not awaited: the first enable can download for a while; progress arrives via onWslStatus.
    if (r === 'wsl') void wsl.setEnabled(true);
    this.deps.applyMdns(this.relayActive(r));
    return this.publish();
  }

  /** A `wsl` route where WSL can't run starts no relay, so DeckBridge must keep advertising. */
  private relayActive(r: PairingRoute): boolean {
    return isRelayRoute(r) && (r !== 'wsl' || this.deps.wsl.status().supported);
  }

  /** The token a script request must carry; null while no script route is selected. */
  scriptToken(): string | null {
    const { supported, settings } = this.deps;
    const { route, token } = settings.pairingRoute;
    return supported && isScriptRoute(route) ? (token ?? null) : null;
  }

  /** `ip` is the socket peer, never a body field: the token only says who may report. */
  onRelayEvent(ev: RelayEvent, ip: string): void {
    const { settings } = this.deps;
    if (this.scriptToken() === null) return;
    this.relay = {
      stage: ev.stage,
      ip,
      platform: ev.platform,
      version: ev.version.replace(/^v/, ''),
      ...(ev.message === undefined ? {} : { message: ev.message }),
      at: this.deps.now(),
    };
    // OrbStack and container NAT their VM, so the peer is this Mac; the IP to add in the app is the VM's own.
    const nat =
      settings.pairingRoute.route === 'orbstack' || settings.pairingRoute.route === 'container';
    const addr = nat ? (ev.selfIp ?? ip) : ip;
    if (settings.pairingRoute.relayIp !== addr) {
      settings.setPairingRoute({ ...settings.pairingRoute, relayIp: addr });
    }
    this.armStaleTimer();
    this.publish();
  }

  /** The stored state with staleness applied; no timer needed to read it. */
  private liveRelay(): RelayProgress | null {
    const r = this.relay;
    if (r === null) return null;
    const age = this.deps.now() - r.at;
    if (r.stage === 'running' && age >= RUNNING_STALE_MS) return { ...r, stage: 'offline' };
    const installing =
      r.stage === 'downloading' || r.stage === 'installing' || r.stage === 'starting';
    if (installing && age >= INSTALL_STALE_MS) {
      return { ...r, stage: 'failed', message: 'No progress' };
    }
    return r;
  }

  /** One republish at the expiry, so an open wizard flips without a poll. */
  private armStaleTimer(): void {
    this.clearStaleTimer();
    const r = this.relay;
    if (r === null || r.stage === 'failed') return;
    const ttl = r.stage === 'running' ? RUNNING_STALE_MS : INSTALL_STALE_MS;
    this.staleTimer = setTimeout(() => {
      this.staleTimer = null;
      this.publish();
    }, ttl + 50);
  }

  private clearStaleTimer(): void {
    if (this.staleTimer !== null) clearTimeout(this.staleTimer);
    this.staleTimer = null;
  }

  stop(): void {
    this.clearStaleTimer();
  }

  dismiss(): PairingRouteStatus {
    const { supported, settings } = this.deps;
    if (!supported || settings.pairingRoute.wizardDismissed === true) return this.status();
    settings.setPairingRoute({ ...settings.pairingRoute, wizardDismissed: true });
    return this.publish();
  }

  /** The persisted route's mDNS side, separate so the wiring can apply it before the CORA
   *  servers advertise; `start()` repeats it harmlessly. */
  applyPersistedMdns(): void {
    if (this.deps.supported)
      this.deps.applyMdns(this.relayActive(this.deps.settings.pairingRoute.route));
  }

  async start(): Promise<void> {
    const { supported, settings, wsl } = this.deps;
    if (!supported) return;
    this.applyPersistedMdns();
    // An OrbStack route saved before tokens existed.
    const saved = settings.pairingRoute;
    if (isScriptRoute(saved.route) && saved.token === undefined) {
      settings.setPairingRoute({ ...saved, token: this.deps.newToken() });
    }
    if (saved.route === 'wsl') void wsl.setEnabled(true);
    this.lastPaired = this.deps.paired();
    // Last: a slow `powershell` must not delay the relay.
    this.elgatoVersion = (await this.readVersion()) ?? null;
    this.publish();
  }

  /** The relay IP follows the WSL IP, so every WSL status change is a route change too. */
  onWslStatus(s: WslRelayStatus): void {
    if (s.wslIp === this.lastWslIp) return;
    this.lastWslIp = s.wslIp;
    if (this.deps.supported && this.deps.settings.pairingRoute.route === 'wsl') this.publish();
  }

  /** On driverManager 'changed'. */
  syncPaired(): void {
    if (!this.deps.supported) return;
    const now = this.deps.paired();
    if (now !== this.lastPaired) {
      this.lastPaired = now;
      this.publish();
    }
  }

  private async readVersion(): Promise<string | undefined> {
    try {
      return await this.deps.readElgatoVersion();
    } catch {
      return undefined;
    }
  }

  private publish(): PairingRouteStatus {
    const s = this.status();
    this.deps.onStatus(s);
    return s;
  }
}
