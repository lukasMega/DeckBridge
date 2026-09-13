// Resolve (and, if needed, download) the Lightpanda browser binary.
//
// `@lightpanda/browser` is a thin wrapper: the npm package does NOT contain the browser,
// and — importantly — pinning the wrapper does NOT pin the browser. `lightpanda install`
// with no argument fetches whatever the *latest nightly* is, so the same lockfile can
// hand you a different browser next week. Measured: wrapper 1.6.0 gave nightly 9384 one
// day and 9405 the next, and 9405 never finished hydrating the docs site
// (`data-has-hydrated="false"`) while running ~5x slower.
//
// So the browser is pinned separately, to a *tagged release* (nightly tags are
// overwritten upstream and cannot be re-fetched by version). The pin lives in
// e2e/.lightpanda-version, which is also the CI cache key.
//
// Usable standalone: `node scripts/ensure-lightpanda.mjs` prints the resolved path.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const CACHE_DIR = join(homedir(), '.cache', 'lightpanda-node');
const CACHED = join(CACHE_DIR, 'lightpanda');
const LOCK = join(CACHE_DIR, '.install.lock');
const VERSION_FILE = join(import.meta.dirname, '..', '.lightpanda-version');

/** @returns {string} the pinned release, e.g. "0.4.0" */
export function pinnedVersion() {
  return readFileSync(VERSION_FILE, 'utf8').trim();
}

/** @returns {string} the version string a binary reports, e.g. "0.4.0" */
export function lightpandaVersion(bin) {
  return execFileSync(bin, ['version'], { encoding: 'utf8' }).trim();
}

/** Same, but a half-written or non-executable file reads as "no usable binary". */
function versionOrNull(bin) {
  if (!existsSync(bin)) return null;
  try {
    return lightpandaVersion(bin);
  } catch {
    return null;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** @returns {string} absolute path to a Lightpanda binary matching the pin */
export function ensureLightpanda() {
  const override = process.env.LIGHTPANDA_EXECUTABLE_PATH;
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`LIGHTPANDA_EXECUTABLE_PATH points at a missing file: ${override}`);
    }
    return override;
  }

  const want = pinnedVersion();
  // A cache hit is only a hit if it is the *pinned* build — a restored CI cache or an
  // older local download must not silently substitute a different browser.
  if (versionOrNull(CACHED) === want) return CACHED;

  // `mise run e2e-browser` starts both suites at once and each runs this, so two
  // processes can race into the same download: one then reads the other's half-written
  // file. mkdir is atomic, so it is the lock — the loser waits and re-checks.
  mkdirSync(CACHE_DIR, { recursive: true });
  for (let waited = 0; waited < 300_000; waited += 500) {
    try {
      mkdirSync(LOCK);
    } catch {
      sleepSync(500);
      if (versionOrNull(CACHED) === want) return CACHED;
      continue;
    }
    try {
      // Run the package's real bin entry, not node_modules/.bin/lightpanda: under pnpm
      // that path is a POSIX `sh` shim (and a .CMD on Windows), so handing it to `node`
      // dies with "SyntaxError: Invalid or unexpected token" on its shebang. Resolving
      // through the package manifest is shim-shape independent.
      const pkgJson = createRequire(import.meta.url).resolve('@lightpanda/browser/package.json');
      execFileSync('node', [join(dirname(pkgJson), 'dist', 'cli', 'main.js'), 'install', want], {
        stdio: 'inherit',
      });
    } finally {
      rmSync(LOCK, { recursive: true, force: true });
    }

    const got = versionOrNull(CACHED);
    if (got === null) {
      throw new Error(`lightpanda install ${want} finished but ${CACHED} is missing or unusable`);
    }
    if (got !== want) throw new Error(`lightpanda install ${want} produced ${got} instead`);
    return CACHED;
  }
  throw new Error(`timed out waiting for another process to install lightpanda ${want}`);
}

if (import.meta.filename === process.argv[1]) {
  const bin = ensureLightpanda();
  console.log(`${bin}  (${lightpandaVersion(bin)})`);
}
