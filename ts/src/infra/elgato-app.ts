// Quit / launch / restart the Elgato Stream Deck desktop app on THIS machine —
// used by the auto-restart scheduler (main/elgato-auto-restart.ts) and the
// manual paths (WebUI "Restart Elgato app now" button, tray "Restart Elgato App").
// See .claude/plans/2026-09-27_auto-restart-elgato-app.md §4.1 for the design.
//
// Quit is deeplink-first (`streamdeck://app/quit`, the same URL the app's own UI
// uses) with a kill fallback only if the app is still alive after a timeout —
// a straight kill can lose unsaved Elgato profile edits, so it's a last resort.
// Everything is injectable (spawn/openUrl/isRunning/platform/sleep) so tests never
// spawn a real process or wait on a real timer.
import { isElgatoAppRunning, openPathInOS, platformName } from './os-utils.ts';
import { log } from '../shared/logger.js';

const MAC_OS = 'macOS';
const WIN = 'Windows';

const QUIT_URL = 'streamdeck://app/quit';
const LAUNCH_URL = 'streamdeck://';
const MAC_APP_NAME = 'Stream Deck';
const MAC_BUNDLE_NAME = 'Elgato Stream Deck';
const WIN_PROCESS_NAME = 'StreamDeck.exe';

/** Default poll cadence while waiting for the process to appear/disappear. */
const POLL_INTERVAL_MS = 500;
/** How long to wait for the deeplink quit before falling back to a kill. */
export const ELGATO_QUIT_TIMEOUT_MS = 5000;
/** How long a `taskkill` (no `/F`) gets before escalating to `/F`. */
const WIN_SOFT_KILL_GRACE_MS = 2000;
/** Wait between quit (confirmed dead) and launch — the app needs a moment to
 *  release its resources before relaunch, per §4.1. */
export const ELGATO_RELAUNCH_DELAY_MS = 3000;
/** How long to wait for the relaunched process to appear before giving up. */
const LAUNCH_VERIFY_TIMEOUT_MS = 10000;

export type RestartResult =
  | { ok: true; killed: boolean } // killed = deeplink quit did not work in time
  | {
      ok: false;
      reason:
        | 'unsupported-platform'
        | 'not-running'
        | 'still-running'
        | 'launch-failed'
        | 'cancelled';
    };

export interface ElgatoAppControl {
  /** Is the Elgato app running on this machine? `false` on any platform without
   *  a build (Linux). */
  isRunning(): Promise<boolean>;
  /** Quit (deeplink, then kill fallback), wait `relaunchDelayMs`, launch.
   *  Resolves with what happened; never throws. A second call while one is
   *  already in flight shares the same promise (see `createElgatoAppControl`). */
  restart(opts?: { relaunchDelayMs?: number; quitTimeoutMs?: number }): Promise<RestartResult>;
  /** Launch the app in the background (no main window). Returns whether the
   *  process was confirmed running afterward. Never throws. */
  launch(): Promise<boolean>;
  /** DeckBridge is quitting: a restart already past its quit step does not relaunch,
   *  and later launches are refused. The app's own running state is left alone. */
  cancelLaunches(): void;
}

interface Deps {
  spawn: typeof tjs.spawn;
  openUrl: (url: string) => Promise<void>;
  isRunning: () => Promise<boolean>;
  platform: () => string;
  sleep: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultDeps(): Deps {
  return {
    spawn: (...args) => tjs.spawn(...args),
    openUrl: openPathInOS,
    isRunning: isElgatoAppRunning,
    platform: platformName,
    sleep: defaultSleep,
  };
}

/** Best-effort spawn — a launcher/killer command that fails to even start
 *  (missing binary, no permission) must not throw past this call; the caller
 *  finds out via the next `isRunning()` poll instead. */
function trySpawn(deps: Deps, args: string[]): void {
  try {
    deps.spawn(args, { stdout: 'ignore', stderr: 'ignore' });
  } catch {}
}

/** Poll `deps.isRunning()` every `POLL_INTERVAL_MS` until it reports `want`, or
 *  `timeoutMs` elapses. Always checks once up front (no wasted sleep when the
 *  state already matches). Returns whether `want` was reached — NOT the raw
 *  `isRunning()` value, which would be wrong half the time (`want: false`
 *  reached ⇒ raw value `false` ⇒ falsy, indistinguishable from "never reached"). */
async function pollUntil(deps: Deps, want: boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let running = await deps.isRunning();
  while (running !== want && Date.now() < deadline) {
    await deps.sleep(POLL_INTERVAL_MS);
    running = await deps.isRunning();
  }
  return running === want;
}

/** Deeplink quit, falling back to a process kill if the app is still alive
 *  after `quitTimeoutMs`. Returns `killed: true` iff the fallback kill ran. */
async function quit(
  deps: Deps,
  platform: string,
  quitTimeoutMs: number,
): Promise<{ dead: boolean; killed: boolean }> {
  await deps.openUrl(QUIT_URL);
  if (await pollUntil(deps, false, quitTimeoutMs)) {
    log('info', 'elgato-app', 'quit via deeplink');
    return { dead: true, killed: false };
  }

  log('info', 'elgato-app', 'deeplink quit timed out — falling back to kill');
  if (platform === MAC_OS) {
    trySpawn(deps, ['pkill', '-x', MAC_APP_NAME]);
  } else {
    trySpawn(deps, ['taskkill', '/IM', WIN_PROCESS_NAME]);
    if (await pollUntil(deps, false, WIN_SOFT_KILL_GRACE_MS)) {
      return { dead: true, killed: true };
    }
    trySpawn(deps, ['taskkill', '/F', '/IM', WIN_PROCESS_NAME]);
  }
  const dead = await pollUntil(deps, false, quitTimeoutMs);
  return { dead, killed: true };
}

/** Each attempt either starts a process/opens a URL (may throw — missing
 *  binary, no permission) or is skipped in favor of the next one. */
function launchAttempts(deps: Deps, platform: string): Array<() => Promise<void> | void> {
  if (platform === MAC_OS) {
    return [
      () => {
        deps.spawn(['open', '-g', '-a', MAC_BUNDLE_NAME], { stdout: 'ignore', stderr: 'ignore' });
      },
      () => {
        deps.spawn(['open', '-g', LAUNCH_URL], { stdout: 'ignore', stderr: 'ignore' });
      },
    ];
  }
  const programFiles = tjs.env.ProgramFiles ?? 'C:\\Program Files';
  return [
    () => {
      deps.spawn([`${programFiles}\\Elgato\\StreamDeck\\StreamDeck.exe`], {
        stdout: 'ignore',
        stderr: 'ignore',
      });
    },
    () => deps.openUrl(LAUNCH_URL),
  ];
}

/** Tries each launch attempt until one starts without throwing, then does a
 *  single `isRunning()` verification poll (up to `LAUNCH_VERIFY_TIMEOUT_MS`) —
 *  not one poll per attempt, so a missing binary fails over immediately
 *  instead of waiting out a full verify window first. */
async function launchWith(deps: Deps, platform: string): Promise<boolean> {
  let spawned = false;
  for (const attempt of launchAttempts(deps, platform)) {
    try {
      await attempt();
      spawned = true;
      break;
    } catch {}
  }
  if (!spawned) return false;
  return pollUntil(deps, true, LAUNCH_VERIFY_TIMEOUT_MS);
}

/** Creates the app-control surface. `deps` overrides are for tests only —
 *  production callers pass none and get real process/spawn/URL behaviour. */
export function createElgatoAppControl(deps: Partial<Deps> = {}): ElgatoAppControl {
  const d: Deps = { ...defaultDeps(), ...deps };
  let inflightRestart: Promise<RestartResult> | undefined;
  let launchesCancelled = false;

  async function isRunning(): Promise<boolean> {
    return d.isRunning();
  }

  async function launch(): Promise<boolean> {
    const platform = d.platform();
    if (platform !== MAC_OS && platform !== WIN) {
      log('info', 'elgato-app', `launch skipped: unsupported platform (${platform || 'unknown'})`);
      return false;
    }
    if (launchesCancelled) return false;
    log('info', 'elgato-app', 'launching');
    const ok = await launchWith(d, platform);
    log('info', 'elgato-app', ok ? 'launch confirmed' : 'launch failed — process never appeared');
    return ok;
  }

  async function doRestart(opts?: {
    relaunchDelayMs?: number;
    quitTimeoutMs?: number;
  }): Promise<RestartResult> {
    const platform = d.platform();
    if (platform !== MAC_OS && platform !== WIN) {
      log('info', 'elgato-app', `restart skipped: unsupported platform (${platform || 'unknown'})`);
      return { ok: false, reason: 'unsupported-platform' };
    }
    if (!(await d.isRunning())) {
      log('info', 'elgato-app', 'restart skipped: not running');
      return { ok: false, reason: 'not-running' };
    }

    const quitTimeoutMs = opts?.quitTimeoutMs ?? ELGATO_QUIT_TIMEOUT_MS;
    const relaunchDelayMs = opts?.relaunchDelayMs ?? ELGATO_RELAUNCH_DELAY_MS;

    const { dead, killed } = await quit(d, platform, quitTimeoutMs);
    if (!dead) {
      log('info', 'elgato-app', 'restart failed: still running after kill fallback');
      return { ok: false, reason: 'still-running' };
    }

    await d.sleep(relaunchDelayMs);
    if (launchesCancelled) {
      log('info', 'elgato-app', 'relaunch skipped: DeckBridge is shutting down');
      return { ok: false, reason: 'cancelled' };
    }

    const launched = await launchWith(d, platform);
    if (!launched) {
      log('info', 'elgato-app', 'restart failed: relaunch never confirmed');
      return { ok: false, reason: 'launch-failed' };
    }

    log('info', 'elgato-app', `restart complete (killed=${killed})`);
    return { ok: true, killed };
  }

  async function restart(opts?: {
    relaunchDelayMs?: number;
    quitTimeoutMs?: number;
  }): Promise<RestartResult> {
    if (inflightRestart) return inflightRestart;
    const p = doRestart(opts).finally(() => {
      inflightRestart = undefined;
    });
    inflightRestart = p;
    return p;
  }

  return {
    isRunning,
    restart,
    launch,
    cancelLaunches: () => {
      launchesCancelled = true;
    },
  };
}
