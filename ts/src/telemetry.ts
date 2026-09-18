// Daily usage ping: OS, DeckBridge version, connected device models. The
// collector stores aggregate counters only (["c", site, day, dim, value] sums),
// so there is no row per install and nothing identifying is transmitted — no
// serial, no install id, no path, no key activity.
//
// Shaped like update-check.ts for the same two reasons: the pure half tests
// without a network, and the IO half spawns curl because this build's `fetch()`
// rejects `https://` (see update-check.ts's header). Every failure is silent.
//
// The once-per-day gate is client-side (`lastPingDay`), so the collector's `app`
// counter is already a distinct-install count for that day — no visitor id is
// sent, and none is needed.
//
// Opt out with `"a7s": false` in settings.json. `"updateCheck": false` disables
// it too — someone who turned off the background update check meant "stop making
// background network calls", not "stop only that one".
import { parseSemver } from './update-check.js';

// `<url>|<site>`, encoded so neither the source tree nor a `strings` sweep of the
// binary advertises the stats host. This is obfuscation, not secrecy: the decode
// is the next line, and the binary must be able to reach the endpoint either way.
// Rotating it takes a source change and a release.
const ENDPOINT = 'aHR0cHM6Ly90c3QubHVrYXNtZWdhLmRlbm8ubmV0L2F8ZGVja2JyaWRnZS1hcHA=';
const [COLLECTOR_URL = '', SITE_ID = ''] = Buffer.from(ENDPOINT, 'base64')
  .toString('utf8')
  .split('|');

const CURL_TIMEOUT_S = 10;

/** Cap on the device ids one ping may carry. A multi-deck setup sends 1-2; the
 *  cap only exists so a corrupt registry can't mint unbounded KV keys. */
const MAX_DEVICE_IDS = 8;

/** Every value lands in a KV key, so an unbounded string is an unbounded key
 *  space. Registry model ids already match this; anything else is dropped. */
const MODEL_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export type TelemetryOs = 'macos' | 'windows' | 'linux' | 'unknown';

/** Short keys because the payload rides in a query string: OS, version, devices. */
export interface TelemetryPayload {
  os: TelemetryOs;
  v: string;
  dv: string;
}

// pure

/** `navigator.userAgentData.platform` (os-utils.ts) is 'macOS'/'Windows'/'Linux',
 *  but accept the runtime-style names too rather than silently filing a whole
 *  platform under `unknown` if that ever changes. */
export function normalizeOs(platform: string): TelemetryOs {
  const p = platform.toLowerCase();
  if (p.includes('mac') || p.includes('darwin')) return 'macos';
  if (p.includes('win')) return 'windows';
  if (p.includes('linux')) return 'linux';
  return 'unknown';
}

/** UTC, to match the collector's own `today()` — a local-time day would file a
 *  ping under a day the server disagrees with, and double-count near midnight. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export interface PayloadInput {
  version: string;
  platform: string;
  modelIds: readonly string[];
}

/** Deduped + sorted so two docks of one model count once and the same hardware
 *  always produces the same string; `none` when nothing is connected, which is a
 *  real answer (the app runs fine with no device plugged in). */
export function buildPayload(input: PayloadInput): TelemetryPayload {
  const ids = [...new Set(input.modelIds.filter((id) => MODEL_ID.test(id)))]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_DEVICE_IDS);
  return {
    os: normalizeOs(input.platform),
    v: input.version,
    dv: ids.length > 0 ? ids.join(',') : 'none',
  };
}

/** Mirrors the collector's decode (`JSON.parse(decodeURIComponent(atob(v)))`).
 *  `encodeURIComponent` first keeps the input inside base64's byte range. */
export function encodePayload(payload: TelemetryPayload): string {
  return Buffer.from(encodeURIComponent(JSON.stringify(payload)), 'utf8').toString('base64');
}

export interface ShouldPingInput {
  enabled: boolean;
  version: string;
  lastPingDay: string | undefined;
  today: string;
}

/** A non-semver version means a local/dev build — those must not land in the
 *  `app_version` dim, where they'd be indistinguishable from a real release. */
export function shouldPing(input: ShouldPingInput): boolean {
  if (!input.enabled) return false;
  if (!parseSemver(input.version)) return false;
  return input.lastPingDay !== input.today;
}

/** The full beacon URL for an already-encoded payload. Percent-encoded: raw
 *  base64 contains `+`, which a query parser decodes back as a space and then
 *  fails to atob. */
export function beaconUrl(encoded: string): string {
  return `${COLLECTOR_URL}?s=${SITE_ID}&v=${encodeURIComponent(encoded)}`;
}

// IO

/** Fire the beacon and forget it. Resolves on every outcome — a missing curl, an
 *  offline machine and a dead collector are all normal, and none of them may
 *  surface anywhere a user would see. `p.kill()` guards a curl that outlives
 *  `--max-time` (a wedged DNS resolver does exactly that). */
export async function sendBeacon(
  encoded: string,
  version: string,
  timeoutMs = (CURL_TIMEOUT_S + 5) * 1000,
): Promise<void> {
  let p: TjsProcess;
  try {
    p = tjs.spawn(
      [
        'curl',
        '-fsS',
        '--max-time',
        String(CURL_TIMEOUT_S),
        '-o',
        '/dev/null',
        '-H',
        `User-Agent: DeckBridge/${version}`,
        beaconUrl(encoded),
      ],
      { stdout: 'ignore', stderr: 'ignore' },
    );
  } catch {
    return;
  }
  const killer = setTimeout(() => {
    try {
      p.kill();
    } catch {}
  }, timeoutMs);
  try {
    await p.wait();
  } catch {
    // offline / killed — nothing to report
  } finally {
    clearTimeout(killer);
  }
}

export interface TelemetryDeps {
  currentVersion: string;
  /** Read fresh each ping so a settings change takes effect without a restart. */
  isEnabled: () => boolean;
  /** UTC day of the last ping — the only telemetry state kept on disk. */
  getLastPingDay: () => string | undefined;
  setLastPingDay: (day: string) => void;
  /** Model ids of the currently open devices. */
  modelIds: () => readonly string[];
  /** Injected so tests never spawn curl — production passes sendBeacon. */
  send: (encoded: string, version: string) => Promise<void>;
  now?: () => Date;
  platform?: () => string;
}

export interface Telemetry {
  /** Never throws. A no-op when disabled, on a dev build, or already sent today. */
  ping(): Promise<void>;
}

export function createTelemetry(deps: TelemetryDeps): Telemetry {
  const now = deps.now ?? ((): Date => new Date());
  const platform = deps.platform ?? ((): string => '');

  async function ping(): Promise<void> {
    const today = utcDay(now());
    const gate: ShouldPingInput = {
      enabled: deps.isEnabled(),
      version: deps.currentVersion,
      lastPingDay: deps.getLastPingDay(),
      today,
    };
    if (!shouldPing(gate)) return;
    // Marked before the send, not after: a collector that hangs or 500s must not
    // turn the 24 h timer into a per-tick retry.
    deps.setLastPingDay(today);
    const payload = buildPayload({
      version: deps.currentVersion,
      platform: platform(),
      modelIds: deps.modelIds(),
    });
    await deps.send(encodePayload(payload), deps.currentVersion);
  }

  return { ping };
}
