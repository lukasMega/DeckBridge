// Backs the "pairing address" helper: is this IP usable for another Elgato dock? Only this
// computer's own addresses are ever touched, and CORA ports are never probed (a probe could
// evict an idle Elgato client from its single client slot).
import { platformName } from '../../infra/os-utils.js';
import { bindAddr } from '../../shared/types.js';
import type {
  AddressTestResult,
  PairingAddressCandidate,
  PairingPlatform,
} from '../contract-pairing.js';
import { ownInterfaceAddresses } from './web-request-guard.js';

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
export const PROBE_TIMEOUT_MS = 1500;
/** Loopback aliases offered first: dock 0 normally uses 127.0.0.1. */
export const LOOPBACK_ALIASES = ['127.0.0.2', '127.0.0.3', '127.0.0.4'];

export function detectPlatform(name: string = platformName()): PairingPlatform {
  const n = name.toLowerCase();
  if (n.includes('mac') || n.includes('darwin')) return 'macos';
  if (n.includes('win')) return 'windows';
  if (n.includes('linux')) return 'linux';
  return 'other';
}

/** Loopback (127/8) or one of this computer's own IPv4s; nothing else may be probed. */
export function isProbeableAddress(
  ip: unknown,
  own: readonly string[] = ownInterfaceAddresses(),
): boolean {
  return typeof ip === 'string' && IPV4.test(ip) && (ip.startsWith('127.') || own.includes(ip));
}

export function pairingCandidates(): PairingAddressCandidate[] {
  return [
    ...LOOPBACK_ALIASES.map((ip) => ({ ip, kind: 'loopback' as const })),
    ...ownInterfaceAddresses().map((ip) => ({ ip, kind: 'lan' as const })),
  ];
}

/** Binds a listener on `ip` (ephemeral port) and connects to it: proves the address exists
 *  locally. Injectable so tests can fail it on any OS. */
export type AddressProbe = (ip: string) => Promise<void>;

export const probeAddress: AddressProbe = async (ip) => {
  const listener = await tjs.listen('tcp', ip, 0);
  try {
    const { localPort } = await listener.opened;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS);
    try {
      const socket = await tjs.connect('tcp', ip, localPort, { signal: abort.signal });
      await socket.opened;
      socket.close();
    } finally {
      clearTimeout(timer);
    }
  } finally {
    listener.close();
  }
};

export async function testAddress(
  ip: string,
  probe: AddressProbe = probeAddress,
  bind: string = bindAddr(),
): Promise<AddressTestResult> {
  try {
    await probe(ip);
  } catch {
    return {
      ok: false,
      stage: 'address',
      error: `${ip} is not an address of this computer yet — run the command above, then test again`,
    };
  }
  // CORA binds `bind`; an alias is only reachable when that is every interface or the alias itself.
  if (bind !== '0.0.0.0' && bind !== ip) {
    return {
      ok: false,
      stage: 'listen',
      error: `${ip} exists, but DeckBridge only listens on ${bind} (--bind). Restart without --bind, or with --bind 0.0.0.0`,
    };
  }
  return { ok: true, stage: 'listen' };
}
