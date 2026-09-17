// Checks GitHub for a newer DeckBridge release — notify only, no download or
// self-update, opt-out via settings.json `updateCheck`. Split pure/IO like
// diagnostics.ts so the comparison logic is unit-testable without network.
//
// Why curl: this build's `fetch()` rejects `https://` (no TLS — see
// plugin-host.ts's runFetch), and the GitHub API is HTTPS-only. `tjs.spawn` is
// the established escape hatch (os-utils.ts, mdns-advertiser.ts, tray.ts).
// Missing curl must never surface as a startup error — see UpdateCheckError.
import { readText } from './os-utils.ts';

const GITHUB_RELEASES_URL = 'https://api.github.com/repos/lukasMega/DeckBridge/releases/latest';
const CURL_TIMEOUT_S = 10;
const MAX_RESPONSE_BYTES = 256 * 1024;

/** 20 h, not 24 h: a user restarting 30x/day must still serve cache between
 *  the periodic 24 h checks, not just at the exact boundary. */
export const RATE_LIMIT_MS = 20 * 60 * 60 * 1000;

/** app.ts scheduling: first check well after startup (never on the blocking
 *  startup path), then once a day. */
export const STARTUP_DELAY_MS = 30 * 1000;
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type UpdateCheckErrorCode = 'no-curl' | 'network' | 'parse';

export class UpdateCheckError extends Error {
  constructor(readonly code: UpdateCheckErrorCode) {
    super(code);
  }
}

export interface LatestRelease {
  version: string;
  url: string;
}

/** Persisted across checks (settings.json `updateState`). */
export interface UpdateState {
  lastCheckedAt: number;
  latestVersion?: string;
  releaseUrl?: string;
  /** The version the user closed the badge for — suppresses the badge, not
   *  `updateAvailable` itself (see createUpdateChecker.toInfo). */
  dismissedVersion?: string;
}

/** Wire DTO — see web/contract.ts's re-export. Kept in sync by hand (this file
 *  cannot import the web-contract leaf: G4 leaves stay leaves). */
export interface UpdateInfo {
  enabled: boolean;
  current: string;
  latest?: string;
  updateAvailable: boolean;
  releaseUrl?: string;
  lastCheckedAt?: number;
  dismissedVersion?: string;
  error?: UpdateCheckErrorCode;
}

// pure

/** `[major, minor, patch]`, or null if `s` isn't a plain numeric triple. */
export function parseSemver(s: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(s.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Numeric triple compare — no pre-release ordering needed. Anything
 *  unparsable ⇒ false (never nag on garbage). */
export function isNewer(latest: string, current: string): boolean {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i]! > b[i]!;
  }
  return false;
}

interface GithubReleaseJson {
  tag_name?: unknown;
  html_url?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

/** `tag_name` like `deckbridge-v0.15.0` (fallback: a leading `v`) → the bare
 *  version + release URL. Drops draft/prerelease — the `/latest` endpoint
 *  already excludes them, this is a belt-and-braces check. */
export function parseLatestRelease(json: string): LatestRelease | null {
  let parsed: GithubReleaseJson;
  try {
    parsed = JSON.parse(json) as GithubReleaseJson;
  } catch {
    return null;
  }
  if (parsed.draft === true || parsed.prerelease === true) return null;
  if (typeof parsed.tag_name !== 'string' || typeof parsed.html_url !== 'string') return null;
  const version = parsed.tag_name.replace(/^deckbridge-v/, '').replace(/^v/, '');
  if (!parseSemver(version)) return null;
  return { version, url: parsed.html_url };
}

// IO

/** Spawn curl for the GitHub releases API and return the raw response body.
 *  Throws `UpdateCheckError('no-curl')` when curl itself can't be spawned,
 *  `UpdateCheckError('network')` on a non-zero exit (offline, DNS, the
 *  `--max-time` timeout, …). `p.kill()` on our own timeout guards against a
 *  hung curl outliving `--max-time` (e.g. a stuck DNS resolver). */
export async function fetchLatestRelease(
  version: string,
  timeoutMs = (CURL_TIMEOUT_S + 5) * 1000,
): Promise<string> {
  let p: TjsProcess;
  try {
    p = tjs.spawn(
      [
        'curl',
        '-fsSL',
        '--max-time',
        String(CURL_TIMEOUT_S),
        '-H',
        'Accept: application/vnd.github+json',
        '-H',
        `User-Agent: DeckBridge/${version}`,
        GITHUB_RELEASES_URL,
      ],
      { stdout: 'pipe', stderr: 'ignore' },
    );
  } catch {
    throw new UpdateCheckError('no-curl');
  }
  const killer = setTimeout(() => {
    try {
      p.kill();
    } catch {}
  }, timeoutMs);
  try {
    const out = await readText(p.stdout);
    const { exit_status } = await p.wait();
    if (exit_status !== 0) throw new UpdateCheckError('network');
    return out.slice(0, MAX_RESPONSE_BYTES);
  } catch (e) {
    if (e instanceof UpdateCheckError) throw e;
    throw new UpdateCheckError('network');
  } finally {
    clearTimeout(killer);
  }
}

export interface UpdateCheckerDeps {
  currentVersion: string;
  /** settings.json `updateCheck` (absent ⇒ enabled) — read fresh each call so
   *  a live toggle takes effect without recreating the checker. */
  isEnabled: () => boolean;
  getState: () => UpdateState | undefined;
  setState: (s: UpdateState) => void;
  /** Injected so tests never spawn curl — production passes fetchLatestRelease. */
  fetchRelease: (version: string) => Promise<string>;
  now?: () => number;
}

export interface UpdateChecker {
  /** Cached DTO — no network. */
  toInfo(): UpdateInfo;
  /** Hits the network unless `force` is false and the 20 h cache is still
   *  warm. Never throws — a failure is reported via `UpdateInfo.error` with
   *  the previous cache preserved. */
  check(force?: boolean): Promise<UpdateInfo>;
  dismiss(version: string): void;
}

/** `isEnabled: () => false` (opt-out) or the settings toggle off ⇒ `check()`
 *  never calls `fetchRelease` at all — asserted by the settings round-trip test. */
export function createUpdateChecker(deps: UpdateCheckerDeps): UpdateChecker {
  const now = deps.now ?? (() => Date.now());

  function toInfo(error?: UpdateCheckErrorCode): UpdateInfo {
    const enabled = deps.isEnabled();
    const state = deps.getState();
    const updateAvailable =
      enabled &&
      state?.latestVersion !== undefined &&
      isNewer(state.latestVersion, deps.currentVersion);
    return {
      enabled,
      current: deps.currentVersion,
      latest: state?.latestVersion,
      updateAvailable,
      releaseUrl: state?.releaseUrl,
      lastCheckedAt: state?.lastCheckedAt,
      dismissedVersion: state?.dismissedVersion,
      ...(error ? { error } : {}),
    };
  }

  async function check(force = false): Promise<UpdateInfo> {
    if (!deps.isEnabled()) return toInfo();
    const state = deps.getState();
    if (!force && state && now() - state.lastCheckedAt < RATE_LIMIT_MS) return toInfo();
    try {
      const json = await deps.fetchRelease(deps.currentVersion);
      const release = parseLatestRelease(json);
      if (!release) {
        deps.setState({ ...state, lastCheckedAt: now() });
        return toInfo('parse');
      }
      deps.setState({
        lastCheckedAt: now(),
        latestVersion: release.version,
        releaseUrl: release.url,
        dismissedVersion: state?.dismissedVersion,
      });
      return toInfo();
    } catch (e) {
      const code = e instanceof UpdateCheckError ? e.code : 'network';
      return toInfo(code);
    }
  }

  function dismiss(version: string): void {
    const state = deps.getState();
    deps.setState({
      lastCheckedAt: state?.lastCheckedAt ?? now(),
      latestVersion: state?.latestVersion,
      releaseUrl: state?.releaseUrl,
      dismissedVersion: version,
    });
  }

  return { toInfo, check, dismiss };
}
