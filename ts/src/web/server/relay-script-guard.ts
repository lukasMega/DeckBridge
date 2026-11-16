// Request checks for the relay script listener (issue #257): who may fetch the script or report
// progress. Pure, so the matrix is tested without a socket.
import type { RelayEventBody } from '../contract-pairing-route.js';

/** Constant-time for equal lengths; the length itself is not secret (always 32). */
export function tokenMatches(given: string | null, expected: string): boolean {
  if (given === null || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

// [first octet, lowest second octet, highest second octet]. 198.18/15 covers the VM networks
// OrbStack and Docker use.
const LAN_RANGES: ReadonlyArray<readonly [number, number, number]> = [
  [10, 0, 255],
  [127, 0, 255],
  [172, 16, 31],
  [192, 168, 168],
  [169, 254, 254],
  [100, 64, 127],
  [198, 18, 19],
];

/** The IPv4 form of a socket peer when it is on a private, link-local, loopback or shared-address
 *  range; null otherwise (the script listener is LAN-only, so anything else is not a relay). */
export function lanPeer(addr: string): string | null {
  const m = V4.exec(addr.replace(/^::ffff:/i, ''));
  if (m === null) return null;
  const octets = m.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return null;
  const [a, b] = octets as [number, number];
  return LAN_RANGES.some(([first, lo, hi]) => a === first && b >= lo && b <= hi)
    ? octets.join('.')
    : null;
}

const STAGES = new Set(['downloading', 'installing', 'starting', 'running', 'failed']);
const PLATFORM_RE = /^[\w-]{1,32}$/;
const VERSION_RE = /^[0-9a-z.+-]{1,32}$/i;
// Printable ASCII without `"` and `\`: the script builds the JSON body by hand.
const MESSAGE_RE = /^[\x20\x21\x23-\x5b\x5d-\x7e]{1,200}$/;

function fieldsValid(o: Record<string, unknown>): boolean {
  const { t, stage, platform, version, message } = o;
  return (
    typeof t === 'string' &&
    typeof stage === 'string' &&
    STAGES.has(stage) &&
    typeof platform === 'string' &&
    PLATFORM_RE.test(platform) &&
    typeof version === 'string' &&
    VERSION_RE.test(version) &&
    (message === undefined || (typeof message === 'string' && MESSAGE_RE.test(message)))
  );
}

/** A valid event body, or null. `t` is checked by the caller against the live token. */
export function parseRelayEvent(text: string): RelayEventBody | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || !fieldsValid(v as Record<string, unknown>)) {
    return null;
  }
  const o = v as RelayEventBody;
  return {
    t: o.t,
    stage: o.stage,
    platform: o.platform,
    version: o.version,
    ...(o.message === undefined ? {} : { message: o.message }),
  };
}

/** Sliding window: at most `max` events per `windowMs`. */
export class RateLimit {
  private hits: number[] = [];
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  allow(now: number): boolean {
    this.hits = this.hits.filter((t) => now - t < this.windowMs);
    if (this.hits.length >= this.max) return false;
    this.hits.push(now);
    return true;
  }
}
