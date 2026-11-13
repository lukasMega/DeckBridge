// Admin side of the pairing route (issue #257). The state machine lives in infra/ and is
// attached by main/pairing-route-wiring.ts; this class only caches the probe and broadcasts.
import type { PairingProbe, PairingRoute, PairingRouteStatus } from '../contract-pairing-route.js';
import type { ControllerHost } from './types.js';

export interface PairingRoutePort {
  status(): PairingRouteStatus;
  setRoute(r: PairingRoute): Promise<PairingRouteStatus>;
  dismiss(): PairingRouteStatus;
  probe(): Promise<PairingProbe>;
}

const UNSUPPORTED: PairingRouteStatus = {
  supported: false,
  route: 'none',
  elgatoVersion: null,
  relayIp: null,
  relayVersion: null,
  versionMismatch: false,
  announcedAt: null,
  paired: false,
  wizardDismissed: false,
};

const NO_PROBE: PairingProbe = {
  platform: 'other',
  lanIp: '',
  coraPort: 0,
  webuiPort: 0,
  relayScriptPort: 0,
  lanReachable: false,
  wsl: null,
  mac: null,
};

/** A probe spawns processes; the wizard asks on every open and every step. */
const PROBE_TTL_MS = 30_000;

export class PairingRouteController {
  private port: PairingRoutePort | null = null;
  private cached: { at: number; value: Promise<PairingProbe> } | null = null;

  constructor(private readonly host: ControllerHost) {}

  attach(port: PairingRoutePort): void {
    this.port = port;
  }

  status(): PairingRouteStatus {
    return this.port?.status() ?? { ...UNSUPPORTED };
  }

  /** Every status change goes to the browsers. */
  publish(status: PairingRouteStatus): void {
    this.host.broadcast('pairingRoute', status);
  }

  setRoute(r: PairingRoute): Promise<PairingRouteStatus> {
    return this.port?.setRoute(r) ?? Promise.resolve(this.status());
  }

  dismiss(): PairingRouteStatus {
    return this.port?.dismiss() ?? this.status();
  }

  /** Concurrent callers share one in-flight probe. */
  probe(): Promise<PairingProbe> {
    const port = this.port;
    if (port === null) return Promise.resolve({ ...NO_PROBE });
    const now = Date.now();
    if (this.cached !== null && now - this.cached.at < PROBE_TTL_MS) return this.cached.value;
    const value = port.probe();
    this.cached = { at: now, value };
    return value;
  }
}
