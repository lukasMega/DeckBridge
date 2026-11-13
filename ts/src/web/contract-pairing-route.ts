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
  /** The IP to add in the Stream Deck app: WSL IP (route wsl) or the announced relay IP. */
  relayIp: string | null;
  /** Version the relay script announced; null before the first announce. */
  relayVersion: string | null;
  /** True when relayVersion differs from DeckBridge's own version. */
  versionMismatch: boolean;
  /** Epoch ms of the last announce. */
  announcedAt: number | null;
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
  } | null;
}

export interface PairingRouteRequest {
  route: PairingRoute;
}

// P2 adds RelayCommandKind, RelayCommandResponse and RelayAnnounceBody (see the plan §Contract).
