// Admin side of the WSL relay (issue #257): its live status and the legacy on/off switch. The
// relay itself lives in infra/ and is attached by main/wsl-relay-wiring.ts; this class never
// spawns anything. Which route is active is the pairing route's business.
import type { WslRelayStatus } from '../contract-wsl-relay.js';
import type { PairingRouteController } from './pairing-route-controller.js';
import type { ControllerHost } from './types.js';

/** What the controller needs from the relay. */
export interface WslRelayPort {
  status(): WslRelayStatus;
  recheck(): Promise<WslRelayStatus>;
}

const UNSUPPORTED: WslRelayStatus = {
  supported: false,
  enabled: false,
  state: 'off',
  wslIp: null,
  ipChanged: false,
  distro: null,
  detail: null,
  fixCommand: null,
};

export class WslRelayController {
  private port: WslRelayPort | null = null;

  constructor(
    private readonly host: ControllerHost,
    private readonly pairingRoute: Pick<PairingRouteController, 'status' | 'setRoute'>,
  ) {}

  attach(port: WslRelayPort): void {
    this.port = port;
  }

  status(): WslRelayStatus {
    return this.port?.status() ?? { ...UNSUPPORTED };
  }

  /** Every relay status change (the relay's `onStatus`) goes to the browsers. */
  publish(status: WslRelayStatus): void {
    this.host.broadcast('wslRelay', status);
  }

  /** The pre-wizard switch, kept for old clients: it is the `wsl` / `none` route (PW-D15).
   *  Enabling replies as soon as the flow has started (the download can take a while);
   *  the rest of the progress comes over the `wslRelay` WS event. */
  async setEnabled(enabled: boolean): Promise<WslRelayStatus> {
    const port = this.port;
    if (port === null || !port.status().supported) return this.status();
    const { route } = this.pairingRoute.status();
    // Switching WSL off must not clobber another route the user picked.
    if (enabled || route === 'wsl') await this.pairingRoute.setRoute(enabled ? 'wsl' : 'none');
    return port.status();
  }

  /** Re-runs the flow; replies with the current status, progress follows over WS. */
  recheck(): WslRelayStatus {
    void this.port?.recheck();
    return this.status();
  }
}
