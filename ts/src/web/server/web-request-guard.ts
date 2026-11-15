import { WEBUI_FALLBACK_PORT_MIN, WEBUI_FALLBACK_PORT_MAX } from '../../shared/types.js';

export function isValidMacAddress(addr: string): boolean {
  const parts = addr.split(':');
  return parts.length === 6 && parts.every((p) => /^[0-9a-f]{2}$/i.test(p));
}

const ALLOWED_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

// This machine's own non-internal IPv4 addresses (mirrors app.ts's localIp detection) —
// with --bind 0.0.0.0 the WebUI is reachable at one of these, so a Host/Origin naming one
// of them literally must be allowed too. Cached with a short TTL, not per request: a phone
// reaches the browser deck by LAN IP, so a DHCP renew must not lock it out until restart,
// while polling tjs.system.networkInterfaces on every request would be wasteful.
export const OWN_IP_CACHE_TTL_MS = 60_000;
let ownInterfaceIps: string[] | null = null;
let ownInterfaceIpsAt = 0;
export function ownInterfaceAddresses(): string[] {
  const now = Date.now();
  if (!ownInterfaceIps || now - ownInterfaceIpsAt > OWN_IP_CACHE_TTL_MS) {
    ownInterfaceIps = tjs.system.networkInterfaces
      .filter((i) => !i.internal && !i.address.includes(':'))
      .map((i) => i.address);
    ownInterfaceIpsAt = now;
  }
  return ownInterfaceIps;
}

/** Test seam: forget the cached addresses. */
export function resetOwnIpCache(): void {
  ownInterfaceIps = null;
}

/** The Origin half of the guard: a browser-sent Origin must name this WebUI. Also the first
 *  check of the token-authenticated push API, which skips the Host check. */
export function isAllowedOrigin(origin: string, port: number): boolean {
  const originLower = origin.toLowerCase();
  const candidates: readonly string[] = [...ALLOWED_HOSTNAMES, ...ownInterfaceAddresses()];
  return candidates.some(
    (h) => originLower === `http://${h}` || originLower === `http://${h}:${port}`,
  );
}

// Guards against DNS rebinding and cross-site requests (CSRF/WS hijack): the WebUI binds to
// 127.0.0.1 by default, but without these checks any website open in the user's browser could
// still reach it via a rebound hostname or a cross-origin fetch/WebSocket.
//
// Host/Origin are matched as `<hostname>:<port>` (the form real browsers send) or bare
// `<hostname>` (no port) — txiki's own `fetch`/serve omit the port from these headers even for
// non-default ports, which the test suite relies on. Accepting the bare form for our fixed
// loopback hostnames doesn't weaken the DNS-rebinding check: the hostname itself must still be
// localhost/127.0.0.1/[::1], or (with --bind 0.0.0.0) one of this machine's own IPv4 addresses.
// The own-IP addition doesn't loosen the DNS-rebinding threat model: a rebinding attack's page
// still sends `Host: <attacker-domain>` (the browser sends the hostname from the URL, not the
// address it resolved to), never the Pi's raw IP literal, so allowing IP literals this machine
// actually owns doesn't give an attacker anything new. IPv4 only — an IPv6 own-address literal
// (bracketed, containing ':') would need its own parsing; not worth it while CORA/WebUI bind
// IPv4 addresses exclusively (see bindAddr()/webuiBindAddr() in types.ts).
export function isAllowedWebRequest(
  host: string | null,
  origin: string | null,
  port: number,
): boolean {
  if (!host) return false;
  const candidates: readonly string[] = [...ALLOWED_HOSTNAMES, ...ownInterfaceAddresses()];
  const hostLower = host.toLowerCase();
  if (!candidates.some((h) => hostLower === h || hostLower === `${h}:${port}`)) {
    return false;
  }

  if (origin !== null && !isAllowedOrigin(origin, port)) return false;
  return true;
}

export async function isPortInUse(port: number): Promise<boolean> {
  try {
    const conn = await tjs.connect('tcp', '127.0.0.1', port);
    conn.close();
    return true;
  } catch {
    return false;
  }
}

/** A bind that keeps failing on ports that look free is not a port conflict (e.g. a bad --bind). */
const MAX_BIND_FAILURES = 5;

/** Every fallback port once, shuffled. */
export function fallbackPorts(random: () => number = Math.random): number[] {
  const ports: number[] = [];
  for (let p = WEBUI_FALLBACK_PORT_MIN; p <= WEBUI_FALLBACK_PORT_MAX; p++) ports.push(p);
  for (let i = ports.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [ports[i], ports[j]] = [ports[j]!, ports[i]!];
  }
  return ports;
}

/** Binds `preferred`, else (when `fallback`) the first fallback port that binds. Both checks are
 *  needed: macOS lets tjs.serve bind 127.0.0.1 over another app's wildcard listener (only the
 *  connect probe sees it), and Windows can refuse a bind with nothing listening (excluded ranges). */
export async function listenWithFallback<T>(
  preferred: number,
  fallback: boolean,
  bind: (port: number) => T,
  inUse: (port: number) => Promise<boolean> = isPortInUse,
): Promise<{ port: number; server: T }> {
  const candidates = fallback
    ? [preferred, ...fallbackPorts().filter((p) => p !== preferred)]
    : [preferred];
  let reason = 'already in use';
  let bindFailures = 0;
  for (const port of candidates) {
    if (await inUse(port)) continue;
    try {
      return { port, server: bind(port) };
    } catch (e) {
      reason = (e as Error).message;
      if (++bindFailures >= MAX_BIND_FAILURES) break;
    }
  }
  throw new Error(
    fallback
      ? `WebUI port ${preferred} and fallback ports ${WEBUI_FALLBACK_PORT_MIN}–${WEBUI_FALLBACK_PORT_MAX} are unavailable (${reason})`
      : `WebUI port ${preferred} is unavailable (${reason}): free it or pass another --webui-port`,
  );
}
