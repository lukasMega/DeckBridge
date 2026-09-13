// Resolve (and, if needed, download) the Lightpanda browser binary.
//
// `@lightpanda/browser` is a thin wrapper: the npm package does NOT contain the
// browser. `lightpanda install` downloads a nightly build into
// ~/.cache/lightpanda-node/lightpanda, and the nightly it picks is decided by the
// wrapper's own version — which is why e2e/package.json pins it exactly.
//
// Usable standalone: `node scripts/ensure-lightpanda.mjs` prints the resolved path.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CACHED = join(homedir(), '.cache', 'lightpanda-node', 'lightpanda');

/** @returns {string} absolute path to a Lightpanda binary */
export function ensureLightpanda() {
  const override = process.env.LIGHTPANDA_EXECUTABLE_PATH;
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`LIGHTPANDA_EXECUTABLE_PATH points at a missing file: ${override}`);
    }
    return override;
  }
  if (existsSync(CACHED)) return CACHED;

  // The wrapper's `install` subcommand is the only supported download path.
  execFileSync(
    'node',
    [join(import.meta.dirname, '..', 'node_modules', '.bin', 'lightpanda'), 'install'],
    {
      stdio: 'inherit',
    },
  );
  if (!existsSync(CACHED)) {
    throw new Error(`lightpanda install finished but ${CACHED} is still missing`);
  }
  return CACHED;
}

/** @returns {string} the nightly version string, e.g. "1.0.0-nightly.9384+d812361f2" */
export function lightpandaVersion(bin) {
  return execFileSync(bin, ['version'], { encoding: 'utf8' }).trim();
}

if (import.meta.filename === process.argv[1]) {
  const bin = ensureLightpanda();
  console.log(`${bin}  (${lightpandaVersion(bin)})`);
}
