// Builds the WSL relay (issue #257) and hooks it to the WebUI, settings, mDNS and the primary
// dock. Windows gets the real runner; DECKBRIDGE_WSL_RELAY_MOCK=<scenario> gets a scripted one
// on any OS (mock builds only); everything else is `supported: false` and spawns nothing.
import type { ElgatoServer } from '../cora/primary-server.js';
import { defaultCacheRoot } from '../infra/native-libs.js';
import { platformName } from '../infra/os-utils.ts';
import type { PersistedSettings } from '../infra/settings.js';
import { WslRelay } from '../infra/wsl-relay.js';
import type { WslRelayDeps, WslRunner } from '../infra/wsl-relay.js';
import { createWindowsWslRunner } from '../infra/wsl-relay-runner.js';
import { relayTarget } from '../infra/wsl-relay-parse.js';
import { mdnsDisabled } from '../shared/cli.js';
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

type MdnsServer = Pick<ElgatoServer, 'setMdnsEnabled'>;

export interface WslRelayWiring {
  start(): void;
  stop(): Promise<void>;
  /** Registers a CORA server (a later dock) so its mDNS follows the relay switch. */
  trackMdns(server: MdnsServer): void;
}

/** `lanIp` is read lazily: app.ts only knows the LAN IP after the web UI is up. */
export function wireWslRelay(deps: WslRelayWiringDeps, lanIp: () => string): WslRelayWiring {
  const { webui, settings, driverManager, primaryDock } = deps;
  const runner = pickWslRunner(tjs.env, platformName());
  const relayDeps: WslRelayDeps = {
    runner,
    version: __VERSION__,
    cacheDir: settings.cacheRoot ?? defaultCacheRoot(),
    hostIps,
    target: () => relayTarget(bindAddr(), lanIp()),
    targetPort: ELGATO_TCP_PORT,
    lastIp: () => settings.wslRelay.lastIp,
    saveLastIp: (ip) => settings.setWslRelay({ ...settings.wslRelay, lastIp: ip }),
    log: (level, message) => log(level, 'wsl-relay', message),
    onStatus: (s) => webui.wslRelay.publish(s),
    supported: runner !== null,
    zipOverride: tjs.env.DECKBRIDGE_WSL_RELAY_ZIP || undefined,
  };
  const relay = new WslRelay(relayDeps);
  const syncPaired = (): void => relay.setPaired(primaryDock.childHasClient);
  driverManager.on('changed', syncPaired);

  // While the relay runs, Stream Deck app must not discover DeckBridge's own-host IP by mDNS,
  // on any dock. A persisted switch applies now, before the CORA servers start advertising.
  const mdnsServers = new Set<MdnsServer>([primaryDock.server]);
  let relayOn = false;
  const applyMdns = (on: boolean): void => {
    if (on === relayOn) return;
    relayOn = on;
    for (const srv of mdnsServers) srv.setMdnsEnabled(!on && !mdnsDisabled());
  };
  if (relayDeps.supported && settings.wslRelay.enabled) applyMdns(true);

  const setEnabled = async (on: boolean): Promise<ReturnType<WslRelay['status']>> => {
    applyMdns(on);
    try {
      return await relay.setEnabled(on);
    } catch (e) {
      log('error', 'wsl-relay', `setEnabled(${on}) failed: ${(e as Error).message}`);
      return relay.status();
    }
  };
  const recheck = async (): Promise<ReturnType<WslRelay['status']>> => {
    try {
      return await relay.recheck();
    } catch (e) {
      log('error', 'wsl-relay', `recheck failed: ${(e as Error).message}`);
      return relay.status();
    }
  };
  webui.wslRelay.attach({ status: () => relay.status(), setEnabled, recheck });

  return {
    start() {
      if (!relayDeps.supported || !settings.wslRelay.enabled) return;
      syncPaired();
      void setEnabled(true);
    },
    stop: () => relay.stop().catch(() => undefined),
    trackMdns(srv) {
      mdnsServers.add(srv);
      if (relayOn) srv.setMdnsEnabled(false);
    },
  };
}
