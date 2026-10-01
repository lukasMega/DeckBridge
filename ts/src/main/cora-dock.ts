// One CORA server pair (primary + child) for a single dock — the composition
// unit above ElgatoServer/ElgatoChildServer (server classes stay). Owns the
// pairing watchdog between them, the config/geometry/mDNS/capabilities push as
// one call (applyModel, was the 5-call applyModelToServers sequence repeated at
// every call site), and one startWithRetry shared by the primary (app.ts wiring,
// unbounded retries — the ports are protocol-fixed and can't fall back) and
// every scanned dock (Dock.start in dock.ts, one attempt — its own scan-tick loop is
// the retry mechanism).
import type { LogLevel } from '../shared/logger.js';
import { watchPairing } from '../cora/pairing-watchdog.js';
import type { PairingWatchdog } from '../cora/pairing-watchdog.js';
import type { ElgatoServer } from '../cora/primary-server.js';
import type { ElgatoChildServer } from '../cora/child-server.js';
import type { DeviceModel } from '../devices/driver.js';
import { applyModelToServers } from './dock-status.js';
import type { DeviceInfo } from './dock-status.js';
import { coraPortConflict } from './cora-startup.js';

export interface CoraDockStartOptions {
  log: (level: LogLevel, component: string, message: string) => void;
  getShuttingDown?: () => boolean;
  /** CORA primary TCP port, included in the bind-conflict message. */
  primaryPort: number;
  /** CORA child TCP port, included in the bind-conflict message. */
  childPort: number;
  /** Default Infinity (the primary dock: the port is protocol-fixed and can't
   *  fall back, so keep retrying). Scanned docks pass 1 — a bind failure there frees
   *  the dock index and a later scan tick retries against a possibly
   *  different physical unit; looping here would just hold the index hostage. */
  maxAttempts?: number;
  delayMs?: number;
}

/** One dock's CORA server pair, plus the pairing watchdog between them.
 *  Constructed over already-built ElgatoServer/ElgatoChildServer instances
 *  (their construction — ports, serials, geometry — stays with the caller;
 *  this class owns what happens to the pair as a unit afterward). */
export class CoraDock {
  private readonly watchdog: PairingWatchdog;
  /** Bumped by stop() so a startWithRetry() in flight stops retrying. */
  private stopGeneration = 0;

  constructor(
    readonly server: ElgatoServer,
    readonly childServer: ElgatoChildServer,
    label: string,
  ) {
    this.watchdog = watchPairing(server, childServer, label);
  }

  /** True once the Elgato app discovered + connected to the Network Dock. */
  get hasClient(): boolean {
    return this.server.hasClient;
  }

  /** True once the paired panel is actively streaming over the child port. */
  get childHasClient(): boolean {
    return this.childServer.hasClient;
  }

  /** One call replacing the config/geometry/mDNS/capabilities push sequence
   *  (device/PID, advertised geometry, mDNS restart, child capabilities). */
  applyModel(model: DeviceModel, deviceInfo?: DeviceInfo): void {
    applyModelToServers(this.server, this.childServer, model, deviceInfo);
  }

  /** Live-rename the mDNS advert (WebUI "Device Identity" edit). */
  setMdnsServiceName(name: string): void {
    this.server.setMdnsServiceName(name);
  }

  /**
   * Start both servers, retrying on bind failure (another instance, a real
   * Elgato dock, or the ESP32 bridge holding these ports). `getShuttingDown()`
   * is re-checked before each attempt so a signal during the retry wait bails
   * instead of retrying forever. Once `maxAttempts` is exhausted, rethrows the
   * last bind error — the default (Infinity) never does.
   */
  async startWithRetry(opts: CoraDockStartOptions): Promise<void> {
    const {
      log,
      getShuttingDown = () => false,
      primaryPort,
      childPort,
      maxAttempts = Infinity,
      delayMs = 5000,
    } = opts;
    const generation = this.stopGeneration;
    const cancelled = (): boolean => getShuttingDown() || generation !== this.stopGeneration;
    for (let attempt = 1; ; attempt++) {
      if (cancelled()) return;
      try {
        await this.server.start();
        await this.childServer.start();
        return;
      } catch (err) {
        // stop() mid-bind rejects the pending listen; that is not a port conflict.
        if (cancelled()) return;
        const msg = coraPortConflict(primaryPort, childPort, `attempt ${attempt}`);
        // log() already mirrors to the WebUI (setWebUILog).
        log('error', 'elgato', `${msg}: ${(err as Error).message}`);
        await this.server.stop().catch(() => undefined);
        await this.childServer.stop().catch(() => undefined);
        if (attempt >= maxAttempts) throw err;
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  /** Idempotent teardown: cancel the watchdog, stop both servers
   *  (server.stop() also stops mDNS). */
  async stop(): Promise<void> {
    this.stopGeneration++;
    this.watchdog.cancel();
    await this.server.stop().catch(() => undefined);
    await this.childServer.stop().catch(() => undefined);
  }
}
