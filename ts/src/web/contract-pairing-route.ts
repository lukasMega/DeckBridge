// Pairing-route DTOs (GET/POST /api/pairing-route*, WS `pairingRoute`). Zero-import leaf.
// Stream Deck app 7.6.1+ refuses a dock at its own computer's IP; a route says how this
// install works around it (issue #257, .claude/plans/2026-11-12_pairing-wizard-761.md).

/** `none`: not set up. `downgrade`: user runs app 7.6.0. The rest run a relay elsewhere. */
export type PairingRoute = 'none' | 'downgrade' | 'wsl' | 'device' | 'container' | 'orbstack';

export interface PairingRouteStatus {
  /** False on Linux (and in the demo): every wizard entry point stays hidden. */
  supported: boolean;
  route: PairingRoute;
  /** Installed Stream Deck app version as read from disk, e.g. '7.6.1' or '7.6.1.23015'. */
  elgatoVersion: string | null;
  /** The IP to add in the Stream Deck app: WSL IP (route wsl) or the reporting relay's IP. */
  relayIp: string | null;
  /** Version the relay script reported; null before the first event. */
  relayVersion: string | null;
  /** True when relayVersion differs from DeckBridge's own version. */
  versionMismatch: boolean;
  /** Epoch ms of the last relay event. */
  announcedAt: number | null;
  /** Live install/run state of the script-started relay (device, orbstack, container); not persisted. */
  relay: RelayProgress | null;
  /** The Stream Deck app holds a session through the primary dock. */
  paired: boolean;
  /** The user closed the auto-opened wizard; it never auto-opens again. */
  wizardDismissed: boolean;
}

export interface PairingProbe {
  platform: 'macOS' | 'Windows' | 'other';
  /** The address a relay dials (DeckBridge's LAN IP, same as app.ts `localIp`). */
  lanIp: string;
  /** CORA primary port the relay targets. */
  coraPort: number;
  /** Actual WebUI port (may be a fallback port). */
  webuiPort: number;
  /** LAN port for the relay install script while the OrbStack route is on (may be a fallback port). */
  relayScriptPort: number;
  /** False when the WebUI binds loopback only: served scripts can't be fetched from the LAN. */
  lanReachable: boolean;
  /** Windows only (null elsewhere). From `wsl.exe -l -v`; never boots the WSL VM. */
  wsl: {
    installed: boolean;
    distros: Array<{ name: string; version: 1 | 2; isDefault: boolean }>;
  } | null;
  /** macOS only (null elsewhere). */
  mac: {
    version: string;
    arch: 'arm64' | 'x86_64';
    orbstack: boolean;
    container: boolean;
    /** Recent kernel NECP drops of the Stream Deck app: its Local Network grant is not active. */
    localNetworkBlocked: boolean;
  } | null;
}

export interface PairingRouteRequest {
  route: PairingRoute;
}

/** `offline` is computed by DeckBridge from the heartbeat gap; the script never sends it. */
export type RelayStage =
  | 'downloading'
  | 'installing'
  | 'starting'
  | 'running'
  | 'offline'
  | 'failed';

export interface RelayProgress {
  stage: RelayStage;
  /** Peer address DeckBridge saw on the event POST (never taken from the body). */
  ip: string;
  /** e.g. 'linux-arm64', 'macos-x86_64'. */
  platform: string;
  /** Version the script installs (bare, no `v`). */
  version: string;
  /** Short reason, only with `failed`. */
  message?: string;
  /** Epoch ms of the last event. */
  at: number;
}

/** Body the relay script POSTs to the script listener's /relay/event. */
export interface RelayEventBody {
  t: string;
  stage: Exclude<RelayStage, 'offline'>;
  platform: string;
  version: string;
  message?: string;
  /** The relay's own IPv4 as it sees it; only trusted to label an OrbStack or container relay (NAT). */
  selfIp?: string;
}

export type RelayCommandKind = 'curl' | 'wget' | 'node' | 'container';

export interface RelayCommandResponse {
  /** One line to paste; carries the script token. */
  command: string;
}
