// Daily usage ping — aggregate counters only, gated once per UTC day client-side
// (so `app` is already that day's install count). Shaped like update-check.ts:
// pure half + a curl beacon, silent on failure. See docs/privacy.md.
import { log } from './logger.js';
import { readText } from './os-utils.js';
import { suppressReason } from './telemetry-env.js';
import type { SuppressReason } from './telemetry-env.js';
import { parseSemver } from './update-check.js';

const ENDPOINT = 'aHR0cHM6Ly90c3QubHVrYXNtZWdhLmRlbm8ubmV0L2F8ZGVja2JyaWRnZS1hcHA=';
const [COLLECTOR_URL = '', SITE_ID = ''] = Buffer.from(ENDPOINT, 'base64')
  .toString('utf8')
  .split('|');

const CURL_TIMEOUT_S = 10;

/** Only bounds a wedged child — the probes answer in milliseconds. */
const OS_VERSION_TIMEOUT_MS = 5000;

/** Cap on the device ids one ping may carry. A multi-deck setup sends 1-2; the
 *  cap only exists so a corrupt registry can't mint unbounded KV keys. */
const MAX_DEVICE_IDS = 8;

/** Every value lands in a KV key, so an unbounded string is an unbounded key
 *  space. Registry model ids already match this; anything else is dropped. */
const MODEL_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Closed vocabulary, same reason as MODEL_ID: `windows-11`, `ubuntu-24.04`, or
 *  a bare distro id on a rolling release. */
const OS_VERSION = /^[a-z][a-z0-9_]{0,15}(?:-[a-z0-9.]{1,12})?$/;

/** Windows 11 reports itself as `10.0.x` — only the build tells it from 10.
 *  https://learn.microsoft.com/windows/release-health/ */
const WIN11_MIN_BUILD = 22000;

export type TelemetryOs = 'macos' | 'windows' | 'linux' | 'unknown';

/** Short keys because the payload rides in a query string. */
export interface TelemetryPayload {
  os: TelemetryOs;
  ov: string;
  v: string;
  dv: string;
  tz: string;
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

/** `UTC+02:00` — the offset, never the IANA zone: no `Intl` in this build, and a
 *  zone is a far sharper fingerprint than ~38 offsets. Shifts with DST, so one
 *  install spans two buckets a year. */
export function tzOffset(now: Date): string {
  // Minutes *behind* UTC, i.e. UTC+2 reports -120.
  const minutes = -now.getTimezoneOffset();
  if (!Number.isFinite(minutes) || Math.abs(minutes) > 16 * 60) return 'unknown';
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Major release only (`macos-26`): a full `26.6.2` mints a KV key per patch per
 *  install, and fingerprints harder for no extra insight. `unknown` on any
 *  surprise — a wrong guess is worse than no value. */
export function parseOsVersion(os: TelemetryOs, raw: string): string {
  const text = raw.trim();
  if (!text) return 'unknown';
  if (os === 'macos') return parseMacVersion(text);
  if (os === 'windows') return parseWindowsVersion(text);
  if (os === 'linux') return parseLinuxVersion(text);
  return 'unknown';
}

/** `sw_vers -productVersion` → `26.6.2`. */
function parseMacVersion(text: string): string {
  const major = /^(\d{1,3})(?:\.|$)/.exec(text)?.[1];
  return major ? `macos-${major}` : 'unknown';
}

/** `cmd /c ver` → `Microsoft Windows [Version 10.0.26100.4652]`. */
function parseWindowsVersion(text: string): string {
  const m = /(\d{1,3})\.\d{1,3}\.(\d{1,6})/.exec(text);
  if (!m) return 'unknown';
  const [, major, build] = m;
  if (major !== '10') return `windows-${major ?? '0'}`;
  return Number(build) >= WIN11_MIN_BUILD ? 'windows-11' : 'windows-10';
}

/** /etc/os-release. VERSION_ID is absent on rolling distros, so the id alone is
 *  a valid answer. */
function parseLinuxVersion(text: string): string {
  const field = (key: string): string =>
    new RegExp(`^${key}=\\"?([^\\"\\n]*)\\"?`, 'm').exec(text)?.[1]?.trim().toLowerCase() ?? '';
  const id = field('ID').replace(/[^a-z0-9_]/g, '');
  if (!id) return 'unknown';
  const version = field('VERSION_ID')
    .replace(/[^0-9.]/g, '')
    .slice(0, 8);
  return version ? `${id}-${version}` : id;
}

export interface PayloadInput {
  version: string;
  platform: string;
  modelIds: readonly string[];
  /** Already bucketed by `parseOsVersion`; `unknown` when detection failed. */
  osVersion: string;
  now: Date;
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
    ov: OS_VERSION.test(input.osVersion) ? input.osVersion : 'unknown',
    v: input.version,
    dv: ids.length > 0 ? ids.join(',') : 'none',
    tz: tzOffset(input.now),
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

/** Raw platform version text. Never throws — a missing `sw_vers`, a locked-down
 *  `cmd` or an unreadable os-release all degrade to the dim's `unknown`. */
export async function readOsVersion(os: TelemetryOs): Promise<string> {
  try {
    if (os === 'linux') {
      const bytes = await tjs.readFile('/etc/os-release');
      return new TextDecoder().decode(bytes);
    }
    if (os === 'macos' || os === 'windows') {
      const cmd = os === 'macos' ? ['sw_vers', '-productVersion'] : ['cmd', '/c', 'ver'];
      const p = tjs.spawn(cmd, { stdout: 'pipe', stderr: 'ignore' });
      // Same guard as sendBeacon: `readText` would await a wedged child's
      // stdout forever.
      const killer = setTimeout(() => {
        try {
          p.kill();
        } catch {}
      }, OS_VERSION_TIMEOUT_MS);
      try {
        const out = await readText(p.stdout);
        await p.wait();
        return out;
      } finally {
        clearTimeout(killer);
      }
    }
  } catch {
    // fall through
  }
  return '';
}

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
  /** Injected so tests never spawn; defaults to `readOsVersion`. */
  readOsVersion?: (os: TelemetryOs) => Promise<string>;
  /** Environment veto (telemetry-env.ts). Read fresh each ping so the dwell
   *  clock advances between ticks. Defaults to the real environment (fail
   *  closed), which also means a test that wants a ping must inject one. */
  suppress?: () => SuppressReason;
}

/** Process start, near enough: this module is imported during startup, and the
 *  dwell gate is a coarse minutes-scale threshold. */
const MODULE_LOAD_MS = Date.now();

function envSuppressReason(): SuppressReason {
  return suppressReason({
    env: typeof tjs !== 'undefined' ? tjs.env : {},
    uptimeMs: Date.now() - MODULE_LOAD_MS,
  });
}

export interface Telemetry {
  /** Never throws. A no-op when disabled, on a dev build, or already sent today. */
  ping(): Promise<void>;
}

export function createTelemetry(deps: TelemetryDeps): Telemetry {
  const now = deps.now ?? ((): Date => new Date());
  const platform = deps.platform ?? ((): string => '');
  const readVersion = deps.readOsVersion ?? readOsVersion;
  const suppress = deps.suppress ?? envSuppressReason;

  async function ping(): Promise<void> {
    // Before the day gate, and without touching `a7sDay`: a suppressed process
    // must leave no trace in settings, so the machine's first real session
    // still pings.
    const blocked = suppress();
    if (blocked) {
      log('debug', 'telemetry', `suppressed (${blocked})`);
      return;
    }
    const at = now();
    const today = utcDay(at);
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
    const os = normalizeOs(platform());
    let rawVersion = '';
    try {
      rawVersion = await readVersion(os);
    } catch {
      // best-effort; the dim has an `unknown` bucket for this
    }
    const payload = buildPayload({
      version: deps.currentVersion,
      platform: platform(),
      modelIds: deps.modelIds(),
      osVersion: parseOsVersion(os, rawVersion),
      now: at,
    });
    await deps.send(encodePayload(payload), deps.currentVersion);
  }

  return { ping };
}
