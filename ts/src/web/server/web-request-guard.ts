export function isValidMacAddress(addr: string): boolean {
  const parts = addr.split(':');
  return parts.length === 6 && parts.every((p) => /^[0-9a-f]{2}$/i.test(p));
}

const ALLOWED_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

// This machine's own non-internal IPv4 addresses (mirrors app.ts's localIp detection) —
// with --bind 0.0.0.0 the WebUI is reachable at one of these, so a Host/Origin naming one
// of them literally must be allowed too. Cached at first use, not refreshed per request:
// cheap, and correct except across a DHCP renew mid-process (rare enough on a bridge that
// otherwise reconnects its own USB/CORA state on any network hiccup — not worth polling
// tjs.system.networkInterfaces on every request for).
let ownInterfaceIps: string[] | null = null;
function ownInterfaceAddresses(): string[] {
  if (!ownInterfaceIps) {
    ownInterfaceIps = tjs.system.networkInterfaces
      .filter((i) => !i.internal && !i.address.includes(':'))
      .map((i) => i.address);
  }
  return ownInterfaceIps;
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

  if (origin !== null) {
    const originLower = origin.toLowerCase();
    if (
      !candidates.some(
        (h) => originLower === `http://${h}` || originLower === `http://${h}:${port}`,
      )
    ) {
      return false;
    }
  }

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

const FALLBACK_PORT_MIN = 64000;
const FALLBACK_PORT_RANGE = 1001;
export const FALLBACK_PORT_ATTEMPTS = 5;

export function pickFallbackPort(): number {
  return FALLBACK_PORT_MIN + Math.floor(Math.random() * FALLBACK_PORT_RANGE); // eslint-disable-line sonarjs/pseudo-random
}
