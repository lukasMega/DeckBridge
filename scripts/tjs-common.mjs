// Shared helpers for the two tjs-provisioning scripts (tjs-download.mjs, the
// default path; tjs-build.mjs, the from-source fallback) and the packager.
// They have the same env contract and the same install tail, so it lives here
// rather than drifting in three places.
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, chmodSync, copyFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { platform } from 'node:os';

const isWin = platform() === 'win32';

/**
 * Validates the shared env contract and short-circuits when the runtime is
 * already installed: a cached/restored $TJS (CI) or an existing local build must
 * not trigger a re-download or a multi-minute rebuild on every `mise run test`.
 * Delete $TJS to force a re-provision.
 *
 * Exits the process (0 = already present, 1 = bad env) rather than returning,
 * which is what both callers want at module top level.
 */
export function requireTjsEnv() {
  const { TJS, TXIKI_VERSION } = process.env;

  if (!TJS || !TXIKI_VERSION) {
    console.error('TJS and TXIKI_VERSION env vars must be set');
    process.exit(1);
  }

  if (existsSync(TJS)) {
    console.log(`tjs already present: ${TJS}`);
    process.exit(0);
  }

  return { TJS, TXIKI_VERSION };
}

/** Installs a proven runtime binary at `from` to `TJS`, executable. */
export function installTjs(from, TJS) {
  mkdirSync(dirname(TJS), { recursive: true });
  copyFileSync(from, TJS);
  chmodSync(TJS, 0o755);
}

/** Toolchain probe: is `cmd` on PATH? Used for actionable preflight errors. */
export function have(cmd) {
  try {
    execSync(`${isWin ? 'where' : 'command -v'} ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
