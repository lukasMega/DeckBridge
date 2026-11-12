// Admin side of the WSL relay (issue #257): the switch and its live status. The relay itself
// lives in infra/ and is attached by main/wsl-relay-wiring.ts; this class never spawns anything.
import type { WslRelayStatus } from '../contract-wsl-relay.js';
import type { ControllerHost } from './types.js';

/** What the controller needs from the relay. `setEnabled` also applies the mDNS side effect. */
export interface WslRelayPort {
  status(): WslRelayStatus;
  setEnabled(on: boolean): Promise<WslRelayStatus>;
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

  constructor(private readonly host: ControllerHost) {}

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

  /** Enabling replies as soon as the flow has started (the download can take a while);
   *  the rest of the progress comes over the `wslRelay` WS event. */
  async setEnabled(enabled: boolean): Promise<WslRelayStatus> {
    const port = this.port;
    if (port === null || !port.status().supported) return this.status();
    const { settings } = this.host;
    settings.setWslRelay({ ...settings.wslRelay, enabled });
    const done = port.setEnabled(enabled);
    if (!enabled) await done;
    return port.status();
  }

  /** Re-runs the flow; replies with the current status, progress follows over WS. */
  recheck(): WslRelayStatus {
    void this.port?.recheck();
    return this.status();
  }
}
