// WSL relay DTOs (GET/POST /api/wsl-relay*, WS `wslRelay`). Zero-import leaf.
// Stream Deck app 7.6.1 refuses a dock at its own computer's IP; a relay inside WSL2 has
// a NAT IP of its own, so the app pairs through it (issue #257, docs/elgato-same-computer.md).

export type WslRelayState =
  /** The switch is off. */
  | 'off'
  /** Probing WSL (distro, kernel, networking mode, glibc). */
  | 'checking'
  /** wsl.exe is missing or no Linux distro is installed. */
  | 'no-wsl'
  /** The default distro runs WSL 1, which shares the Windows IPs. */
  | 'wsl1'
  /** WSL networkingMode=mirrored shares the Windows IPs. */
  | 'mirrored'
  /** The distro's glibc is older than 2.38 (the Linux build needs 2.38+). */
  | 'old-glibc'
  | 'downloading'
  | 'download-failed'
  /** Relay started, asking DeckBridge for the dock identity. */
  | 'starting'
  /** The relay can't reach DeckBridge on Windows (most likely the firewall). */
  | 'blocked'
  /** Listening: add `wslIp` in the Stream Deck app. */
  | 'ready'
  /** The Stream Deck app is connected through the relay. */
  | 'paired'
  /** The relay exited or failed unexpectedly; see `detail`. */
  | 'error';

export interface WslRelayStatus {
  /** False hides every WSL relay control (only Windows, or a mock scenario). */
  supported: boolean;
  /** The persisted switch. */
  enabled: boolean;
  state: WslRelayState;
  /** The relay's address inside WSL, the one to add in the Stream Deck app. */
  wslIp: string | null;
  /** True when `wslIp` differs from the one saved at the last successful start. */
  ipChanged: boolean;
  /** The WSL distro the relay runs in, e.g. 'Ubuntu-24.04'. */
  distro: string | null;
  /** One short sentence for the current state (error text, found glibc version …). */
  detail: string | null;
  /** A command the user can copy to fix the current blocking state. */
  fixCommand: string | null;
}

export interface WslRelayToggleRequest {
  enabled: boolean;
}
