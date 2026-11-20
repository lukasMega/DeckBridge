// Pure view-model for the Settings relay details (no Preact, no store).
import type { DocsTopic } from '../../../contract.js';
import type { StatusChipVariant } from '../../components/StatusChip.js';
import type {
  PairingRoute,
  PairingRouteStatus,
  RelayProgress,
  WslRelayStatus,
} from '../../ui-types.js';
import type { WslRelayState } from '../../../contract-wsl-relay.js';

export interface Health {
  label: string;
  variant: StatusChipVariant;
  spin: boolean;
}

const health = (label: string, variant: StatusChipVariant, spin = false): Health => ({
  label,
  variant,
  spin,
});

// A Record, not a switch: a new WslRelayState must pick its chip here (compile error otherwise).
const NEEDS_ATTENTION = health('Needs attention', 'accent');
const RUNNING = health('Running', 'ok');
const WSL_HEALTH: Record<WslRelayState, Health> = {
  off: health('Off', 'dim'),
  checking: health('Checking', 'wait', true),
  downloading: health('Downloading', 'wait', true),
  starting: health('Starting', 'wait', true),
  ready: RUNNING,
  paired: RUNNING,
  'no-wsl': NEEDS_ATTENTION,
  wsl1: NEEDS_ATTENTION,
  mirrored: NEEDS_ATTENTION,
  'old-glibc': NEEDS_ATTENTION,
  'download-failed': NEEDS_ATTENTION,
  blocked: NEEDS_ATTENTION,
  error: NEEDS_ATTENTION,
};

function wslHealth(wsl: WslRelayStatus | null): Health {
  return wsl === null ? health('Not reported yet', 'dim') : WSL_HEALTH[wsl.state];
}

function scriptHealth(relay: RelayProgress | null): Health {
  switch (relay?.stage) {
    case undefined:
      return health('Not reported yet', 'dim');
    case 'downloading':
    case 'installing':
    case 'starting':
      return health('Installing', 'wait', true);
    case 'running':
      return health('Running', 'ok');
    case 'offline':
      return health('Offline', 'accent');
    case 'failed':
      return health('Failed', 'accent');
  }
}

/** Script routes (device, orbstack, container) read `s.relay`; wsl reads `wsl`. */
export function relayHealth(s: PairingRouteStatus, wsl: WslRelayStatus | null): Health {
  return s.route === 'wsl' ? wslHealth(wsl) : scriptHealth(s.relay);
}

/** Null when unknown or the browser clock is more than 5 s behind DeckBridge's. */
export function seenAgo(at: number | null, now: number): string | null {
  if (at === null) return null;
  const diff = now - at;
  if (diff < -5000) return null;
  const sec = diff / 1000;
  if (sec < 10) return 'just now';
  if (sec < 60) return `${Math.floor(sec)} s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  return `${Math.floor(min / 60)} h ago`;
}

export function buildLine(relay: RelayProgress | null): string | null {
  return relay === null ? null : `${relay.platform} · v${relay.version}`;
}

export function relayAddress(s: PairingRouteStatus, wsl: WslRelayStatus | null): string | null {
  if (s.route === 'wsl') return wsl?.wslIp ?? s.relayIp ?? null;
  return s.relayIp ?? s.relay?.ip ?? null;
}

export function appLine(
  s: PairingRouteStatus,
  relayAddr: string | null,
  elgatoRemoteAddr: string | null,
): string {
  if (s.paired && elgatoRemoteAddr !== null) {
    const viaRelay = elgatoRemoteAddr === relayAddr || elgatoRemoteAddr === s.relay?.ip;
    return viaRelay ? 'Paired via relay' : `Paired from ${elgatoRemoteAddr}`;
  }
  return s.paired ? 'Paired' : 'Waiting for the Stream Deck app';
}

const SH_TAIL = /\| sh$/;

export function uninstallCommand(run: string | null): string | null {
  if (run === null || !SH_TAIL.test(run)) return null;
  return run.replace(SH_TAIL, '| sh -s -- --uninstall');
}

export function relayProblem(s: PairingRouteStatus, ownVersion: string): string | null {
  if (s.route === 'wsl') return null;
  const relay = s.relay;
  if (relay?.stage === 'failed') {
    return `${relay.message ?? 'Install failed.'} Run the command again on the device.`;
  }
  if (relay?.stage === 'offline') {
    return 'Relay offline. Check the device, or run the command again.';
  }
  if (s.versionMismatch && s.relayVersion !== null) {
    return `The relay runs version ${s.relayVersion}, DeckBridge runs ${ownVersion}. Run the command again on the device.`;
  }
  return null;
}

export function detailsTopic(route: PairingRoute): DocsTopic {
  if (route === 'wsl') return 'wsl-relay';
  return route === 'orbstack' ? 'relay-orbstack' : 'relay-device';
}
