// Pairing-address helper DTOs (GET/POST /api/pairing-addresses*). Zero-import leaf.
// The Elgato app pairs one network dock per IP address of this computer, so a third dock
// needs another local address (usually a loopback alias).

export type PairingPlatform = 'macos' | 'windows' | 'linux' | 'other';

export interface PairingAddressCandidate {
  ip: string;
  kind: 'loopback' | 'lan';
}

export interface PairingAddressDock {
  index: number;
  name: string;
  /** What to enter in the Elgato app next to the IP. */
  primaryPort: number;
  running: boolean;
}

export interface PairingAddressesInfo {
  platform: PairingPlatform;
  /** The address to try first (an unused loopback alias). */
  suggested: string;
  candidates: PairingAddressCandidate[];
  docks: PairingAddressDock[];
  /** The `--bind` address DeckBridge listens on for CORA ('0.0.0.0' by default). */
  bindAddress: string;
}

export interface AddressTestRequest {
  ip: string;
}

/** `address`: the IP exists on this computer. `listen`: DeckBridge's CORA servers answer on it. */
export interface AddressTestResult {
  ok: boolean;
  stage: 'address' | 'listen';
  error?: string;
}
