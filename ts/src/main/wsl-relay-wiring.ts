// Builds the WSL relay (issue #257) and hooks it to the WebUI, settings and the primary dock;
// main/pairing-route-wiring.ts decides when it runs. Windows gets the real runner;
// DECKBRIDGE_WSL_RELAY_MOCK=<scenario> gets a scripted one on any OS (mock builds only);
// everything else is `supported: false` and spawns nothing.
import type { ElgatoServer } from '../cora/primary-server.js';
import { defaultCacheRoot } from '../infra/native-libs.js';
import type { PersistedSettings } from '../infra/settings.js';
import { WslRelay } from '../infra/wsl-relay.js';
import type { WslRelayDeps, WslRunner } from '../infra/wsl-relay.js';

// The contract is off-limits to `main` (eslint boundaries); the relay's own type is the same.
type WslRelayStatus = ReturnType<WslRelay['status']>;
import { createWindowsWslRunner } from '../infra/wsl-relay-runner.js';
import { relayTarget } from '../infra/wsl-relay-parse.js';
import { log } from '../shared/logger.js';
import { bindAddr, ELGATO_TCP_PORT } from '../shared/types.js';
import type { WebUIServer } from '../web/server/index.js';
import type { DriverManager } from './driver-manager.js';

// Dynamic so a shipped bundle carries no scripted runner.
const mockModule = __MOCK_BUILD__ ? await import('../infra/wsl-relay-mock.js') : null;

export interface WslRelayWiringDeps {
  webui: WebUIServer;
  settings: PersistedSettings;
  driverManager: Pick<DriverManager, 'on'>;
  primaryDock: { readonly server: ElgatoServer; readonly childHasClient: boolean };
  /** The pairing route's reaction to every relay status change (the relay IP follows it). */
  onStatus: (s: WslRelayStatus) => void;
}

/** Which runner drives WSL, or null when this system can't run the relay. */
export function pickWslRunner(
  env: Record<string, string | undefined>,
  platform: string,
): WslRunner | null {
  const scenario = env.DECKBRIDGE_WSL_RELAY_MOCK ?? '';
  if (mockModule?.isMockWslScenario(scenario)) return mockModule.createMockWslRunner(scenario);
  return platform === 'Windows' ? createWindowsWslRunner() : null;
}

/** The host's own IPv4 addresses (loopback included: WSL never shares it). */
function hostIps(): string[] {
  return tjs.system.networkInterfaces.map((i) => i.address).filter((a) => !a.includes(':'));
}

/** The relay port the pairing route drives; `stop` keeps the persisted route. */
export interface WslRelayWiring {
  status(): WslRelayStatus;
  setEnabled(on: boolean): Promise<WslRelayStatus>;
  recheck(): Promise<WslRelayStatus>;
  stop(): Promise<void>;
}

/** `lanIp` is read lazily: app.ts only knows the LAN IP after the web UI is up. The runner is
 *  chosen by the caller so the pairing route can tell whether WSL can run at all. */
export function wireWslRelay(
  deps: WslRelayWiringDeps,
  runner: WslRunner | null,
  lanIp: () => string,
): WslRelayWiring {
  const { webui, settings, driverManager, primaryDock } = deps;
  const relayDeps: WslRelayDeps = {
    runner,
    version: __VERSION__,
    cacheDir: settings.cacheRoot ?? defaultCacheRoot(),
    hostIps,
    target: () => relayTarget(bindAddr(), lanIp()),
    targetPort: ELGATO_TCP_PORT,
    lastIp: () => settings.pairingRoute.wslLastIp,
    saveLastIp: (ip) => settings.setPairingRoute({ ...settings.pairingRoute, wslLastIp: ip }),
    log: (level, message) => log(level, 'wsl-relay', message),
    onStatus: (s) => {
      webui.wslRelay.publish(s);
      deps.onStatus(s);
    },
    supported: runner !== null,
    zipOverride: tjs.env.DECKBRIDGE_WSL_RELAY_ZIP || undefined,
  };
  const relay = new WslRelay(relayDeps);
  const syncPaired = (): void => relay.setPaired(primaryDock.childHasClient);
  driverManager.on('changed', syncPaired);

  const setEnabled = async (on: boolean): Promise<WslRelayStatus> => {
    // The Stream Deck app may already be connected by the time the relay starts.
    if (on) syncPaired();
    try {
      return await relay.setEnabled(on);
    } catch (e) {
      log('error', 'wsl-relay', `setEnabled(${on}) failed: ${(e as Error).message}`);
      return relay.status();
    }
  };
  const recheck = async (): Promise<WslRelayStatus> => {
    try {
      return await relay.recheck();
    } catch (e) {
      log('error', 'wsl-relay', `recheck failed: ${(e as Error).message}`);
      return relay.status();
    }
  };
  webui.wslRelay.attach({ status: () => relay.status(), recheck });

  return {
    status: () => relay.status(),
    setEnabled,
    recheck,
    stop: () => relay.stop().catch(() => undefined),
  };
}
