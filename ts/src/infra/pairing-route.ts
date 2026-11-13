// State of the pairing route (issue #257): which workaround this install uses against Stream
// Deck app 7.6.1+ refusing a dock at its own IP. Pure over injected deps so the sequencing
// (persist, WSL relay, mDNS) is tested with fakes; main/pairing-route-wiring.ts builds the real one.
import type { PairingRoute, PairingRouteStatus } from '../web/contract-pairing-route.js';
import type { WslRelayStatus } from '../web/contract-wsl-relay.js';
import type { PairingRouteSettings } from './settings-store.js';

/** Routes where a relay dials DeckBridge, so mDNS must not hand the app DeckBridge's own IP. */
export function isRelayRoute(r: PairingRoute): boolean {
  return r === 'wsl' || r === 'device' || r === 'container' || r === 'orbstack';
}

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
}

export class PairingRouteState {
  private elgatoVersion: string | null = null;
  /** Only to publish on a change; `status()` reads the live values. */
  private lastPaired = false;
  private lastWslIp: string | null = null;

  constructor(private readonly deps: PairingRouteDeps) {}

  status(): PairingRouteStatus {
    const { supported, settings, wsl } = this.deps;
    const { route, relayIp, wizardDismissed } = settings.pairingRoute;
    return {
      supported,
      route,
      elgatoVersion: this.elgatoVersion,
      relayIp: route === 'wsl' ? wsl.status().wslIp : (relayIp ?? null),
      // Filled by the P2 announce endpoint.
      relayVersion: null,
      versionMismatch: false,
      announcedAt: null,
      paired: this.deps.paired(),
      wizardDismissed: wizardDismissed === true,
    };
  }

  async setRoute(r: PairingRoute): Promise<PairingRouteStatus> {
    const { supported, settings, wsl } = this.deps;
    const from = settings.pairingRoute.route;
    if (!supported || r === from) return this.status();
    const next: PairingRouteSettings = { ...settings.pairingRoute, route: r };
    // The announced relay belongs to the old route.
    delete next.relayIp;
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
    if (settings.pairingRoute.route === 'wsl') void wsl.setEnabled(true);
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
