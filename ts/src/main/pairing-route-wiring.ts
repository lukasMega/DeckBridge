// Builds the pairing route (issue #257): the WSL relay, the mDNS switch and the route state, and
// hooks them to the WebUI and the primary dock. Supported on macOS and Windows only;
// DECKBRIDGE_PAIRING_MOCK=<scenario> fakes the probe on any OS (mock builds only).
import type { ElgatoServer } from '../cora/primary-server.js';
import { elgatoAppVersion, platformName } from '../infra/os-utils.ts';
import { PairingRouteState } from '../infra/pairing-route.js';
import { createProbeRunner, probePairing } from '../infra/pairing-probe.js';
import { mdnsDisabled } from '../shared/cli.js';
import { log } from '../shared/logger.js';
import { relayTarget } from '../infra/wsl-relay-parse.js';
import { bindAddr, ELGATO_TCP_PORT, webuiBindAddr } from '../shared/types.js';
import { RELAY_SCRIPT_PATH } from '../web/server/relay-script.js';
import { deviceScript } from '../web/server/relay-script-device.js';
import { RelayScriptServer } from '../web/server/relay-script-server.js';
import { pickWslRunner, wireWslRelay } from './wsl-relay-wiring.js';
import type { WslRelayWiringDeps } from './wsl-relay-wiring.js';

// Dynamic so a shipped bundle carries no scripted probe.
const mockModule = __MOCK_BUILD__ ? await import('../infra/pairing-probe-mock.js') : null;

function randomToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

type MdnsServer = Pick<ElgatoServer, 'setMdnsEnabled'>;

export interface PairingRouteWiring {
  start(): void;
  stop(): Promise<void>;
  /** Registers a CORA server (a later dock) so its mDNS follows the route. */
  trackMdns(server: MdnsServer): void;
}

/** `lanIp` is read lazily: app.ts only knows the LAN IP after the web UI is up. */
export function wirePairingRoute(
  deps: Omit<WslRelayWiringDeps, 'onStatus'>,
  lanIp: () => string,
): PairingRouteWiring {
  const { webui, settings, driverManager, primaryDock } = deps;
  const platform = platformName();
  const mockEnv = tjs.env.DECKBRIDGE_PAIRING_MOCK ?? '';
  const scenario =
    mockModule !== null && mockModule.isMockPairingScenario(mockEnv) ? mockEnv : null;

  // While a relay route is active, the Stream Deck app must not discover DeckBridge's own-host
  // IP by mDNS, on any dock.
  const mdnsServers = new Set<MdnsServer>([primaryDock.server]);
  let relayOn = false;
  const applyMdns = (on: boolean): void => {
    if (on === relayOn) return;
    relayOn = on;
    for (const srv of mdnsServers) srv.setMdnsEnabled(!on && !mdnsDisabled());
  };

  // Serves the install scripts of the OrbStack and other-device routes, and only while one of
  // them is selected.
  const scriptServer = new RelayScriptServer({
    listenIp: bindAddr(),
    token: () => state.scriptToken(),
    script: ({ token, port }) => {
      const target = relayTarget(bindAddr(), lanIp());
      if (!('ip' in target)) return null;
      // One script for both routes, so OrbStack reports progress like any other device.
      return deviceScript({
        version: __VERSION__,
        target: target.ip,
        targetPort: ELGATO_TCP_PORT,
        scriptPort: port,
        token,
      });
    },
    onEvent: (ev, ip) => state.onRelayEvent(ev, ip),
    log: (level, msg) => log(level, 'pairing', msg),
  });
  const syncScriptServer = (route: string): void => {
    if (route === 'orbstack' || route === 'device') void scriptServer.start();
    else void scriptServer.stop();
  };
  // The one line the wizard shows; the token only ever travels in this reply (PW-D18).
  const relayCommand = async (kind: 'curl' | 'wget'): Promise<string | null> => {
    const token = state.scriptToken();
    const target = relayTarget(bindAddr(), lanIp());
    if (token === null || !('ip' in target)) return null;
    const url = `http://${target.ip}:${await scriptServer.reservePort()}${RELAY_SCRIPT_PATH}?t=${token}`;
    return kind === 'wget' ? `wget -qO- "${url}" | sh` : `curl -fsSL "${url}" | sh`;
  };

  const wsl = wireWslRelay(
    { ...deps, onStatus: (s) => state.onWslStatus(s) },
    pickWslRunner(tjs.env, platform),
    lanIp,
  );
  // The WSL relay mock (any OS) keeps its documented review path working without a probe mock.
  const supported =
    platform === 'macOS' || platform === 'Windows' || scenario !== null || wsl.status().supported;
  const state: PairingRouteState = new PairingRouteState({
    supported,
    version: __VERSION__,
    settings,
    wsl,
    applyMdns,
    readElgatoVersion: elgatoAppVersion,
    paired: () => primaryDock.childHasClient,
    newToken: randomToken,
    now: Date.now,
    onStatus: (s) => {
      webui.pairingRoute.publish(s);
      syncScriptServer(s.route);
    },
  });
  driverManager.on('changed', () => state.syncPaired());
  // A persisted route silences mDNS now, before the CORA servers start advertising.
  state.applyPersistedMdns();

  const runner = createProbeRunner();
  const probe = async (): ReturnType<typeof probePairing> => {
    const webuiBind = webuiBindAddr();
    // Same target the WSL relay dials: honours --bind; '' when nothing can reach DeckBridge.
    const target = relayTarget(bindAddr(), lanIp());
    const base = {
      lanIp: 'ip' in target ? target.ip : '',
      coraPort: ELGATO_TCP_PORT,
      webuiPort: webui.port,
      relayScriptPort: await scriptServer.reservePort(),
    };
    if (scenario !== null && mockModule !== null) {
      return mockModule.mockProbe(scenario, {
        ...base,
        lanReachable: !webuiBind.startsWith('127.'),
      });
    }
    return probePairing({ runner, platform, webuiBind, ...base });
  };
  webui.pairingRoute.attach({
    status: () => state.status(),
    setRoute: (r) => state.setRoute(r),
    dismiss: () => state.dismiss(),
    probe,
    command: relayCommand,
  });

  return {
    start() {
      void state.start();
    },
    stop: async () => {
      state.stop();
      await scriptServer.stop();
      await wsl.stop();
    },
    trackMdns(srv) {
      mdnsServers.add(srv);
      if (relayOn) srv.setMdnsEnabled(false);
    },
  };
}
