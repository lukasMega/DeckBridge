export function isValidMacAddress(addr: string): boolean {
  const parts = addr.split(':');
  return parts.length === 6 && parts.every((p) => /^[0-9a-f]{2}$/i.test(p));
}

const ALLOWED_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

// Guards against DNS rebinding and cross-site requests (CSRF/WS hijack): the WebUI binds to
// 127.0.0.1, but without these checks any website open in the user's browser could still
// reach it via a rebound hostname or a cross-origin fetch/WebSocket.
//
// Host/Origin are matched as `<hostname>:<port>` (the form real browsers send) or bare
// `<hostname>` (no port) — txiki's own `fetch`/serve omit the port from these headers even for
// non-default ports, which the test suite relies on. Accepting the bare form for our fixed
// loopback hostnames doesn't weaken the DNS-rebinding check: the hostname itself must still be
// localhost/127.0.0.1/[::1].
export function isAllowedWebRequest(
  host: string | null,
  origin: string | null,
  port: number,
): boolean {
  if (!host) return false;
  const hostLower = host.toLowerCase();
  if (!ALLOWED_HOSTNAMES.some((h) => hostLower === h || hostLower === `${h}:${port}`)) {
    return false;
  }

  if (origin !== null) {
    const originLower = origin.toLowerCase();
    if (
      !ALLOWED_HOSTNAMES.some(
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
