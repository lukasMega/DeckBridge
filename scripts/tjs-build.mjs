#!/usr/bin/env node
// Build the SLIM txiki.js runtime from source into $TJS.
//
// This is the fallback for platforms with no prebuilt slim asset (macOS x86_64)
// and the escape hatch when you want to build the runtime yourself; the default
// path is scripts/tjs-download.mjs, which fetches the same artifact prebuilt.
//
// It does NOT hand-roll cmake flags: the fork ships scripts/build-dist.mjs, the
// same driver its release CI runs, so `--profile ffi` here produces exactly the
// published `txiki-slim-ffi-*` binary (FFI in; TLS/WASM/SQLite/mimalloc and the
// eval/serve/test/bundle/app subcommands out; MinSizeRel + compressed bytecode
// + hardened + stripped).
//
// Requires: git, cmake, a C/C++ toolchain, npm (esbuild comes from the clone's
// node_modules — build-dist.mjs never fetches it at build time).
//
// Env (same contract as tjs-download.mjs):
//   TJS            destination path for the runtime binary (vendor/.../build/tjs)
//   TXIKI_VERSION  release tag to build (e.g. slim-v26.6.0-6)

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, chmodSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';

const { TJS, TXIKI_VERSION } = process.env;

if (!TJS || !TXIKI_VERSION) {
  console.error('TJS and TXIKI_VERSION env vars must be set');
  process.exit(1);
}

// Same no-op-when-present contract as tjs-download.mjs: a cached/restored $TJS
// (CI) or an existing local build must not trigger a multi-minute rebuild on
// every `mise run test`. Delete $TJS to force a rebuild.
if (existsSync(TJS)) {
  console.log(`tjs already present: ${TJS}`);
  process.exit(0);
}

const isWin = platform() === 'win32';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'https://github.com/lukasMega/txiki.js-with-slim-builds.git';

// --- Toolchain preflight: fail with an actionable message, not a build error ---
function have(cmd) {
  try {
    execSync(`${isWin ? 'where' : 'command -v'} ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const missing = ['git', 'cmake', 'npm'].filter((c) => !have(c));
if (!isWin && !['cc', 'clang', 'gcc'].some(have)) missing.push('a C/C++ compiler (cc/clang/gcc)');

if (missing.length) {
  console.error(
    [
      `Cannot build txiki.js from source: missing ${missing.join(', ')}.`,
      '',
      '  macOS:  xcode-select --install && brew install cmake libffi',
      '  Debian: sudo apt-get install -y build-essential cmake git libffi-dev',
      '',
      'No toolchain? Use the prebuilt runtime instead:  mise run tjs-setup',
    ].join('\n'),
  );
  process.exit(1);
}

// Build in a dedicated dir so an existing working runtime at $TJS is never
// clobbered until the new binary exists.
const srcDir = join(repoRoot, 'vendor', 'txiki.js-src', TXIKI_VERSION);
const outDir = join(srcDir, 'dist');
const builtTjs = join(outDir, isWin ? 'tjs.exe' : 'tjs');

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

try {
  // Fresh checkout each run keeps the build deterministic.
  // maxRetries: a stale clone contains read-only git objects and (on Windows)
  // files a virus scanner may still hold open — a single rmSync can hit ENOTEMPTY.
  rmSync(srcDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  mkdirSync(dirname(srcDir), { recursive: true });

  console.log(`Cloning ${REPO} @ ${TXIKI_VERSION} (with submodules) ...`);
  run('git', ['clone', '--depth=1', '--branch', TXIKI_VERSION, '--recursive', '--shallow-submodules', REPO, srcDir]);

  // build-dist.mjs resolves esbuild from the clone's node_modules and fails if
  // it isn't there. --ignore-scripts: the fork's root postinstall runs
  // `npm install --prefix website` (Docusaurus), which has no lockfile and
  // fails under `npm ci` — and the docs site is irrelevant to the runtime.
  // esbuild still works: its binary ships in the @esbuild/<platform> optional
  // dep, and bin/esbuild is a JS shim, so no install script is needed.
  console.log('Installing build deps (npm ci --ignore-scripts) ...');
  // npm.cmd on Windows: npm is a shim, not an .exe, so execFileSync can't spawn
  // plain `npm` there (and `shell: true` would re-introduce quoting problems).
  run(isWin ? 'npm.cmd' : 'npm', ['ci', '--ignore-scripts', '--no-fund', '--no-audit'], { cwd: srcDir });

  console.log('Building slim runtime (build-dist.mjs --profile ffi) ...');
  run(process.execPath, ['scripts/build-dist.mjs', '--profile', 'ffi', '--out', outDir], { cwd: srcDir });

  if (!existsSync(builtTjs)) {
    console.error(`Build finished but ${builtTjs} not found`);
    process.exit(1);
  }

  // Only now that we have a proven slim binary (build-dist.mjs smoke-tests it
  // itself), install it to $TJS.
  mkdirSync(dirname(TJS), { recursive: true });
  copyFileSync(builtTjs, TJS);
  chmodSync(TJS, 0o755);
  console.log(`slim tjs installed: ${TJS}`);
} catch (err) {
  console.error(`\ntxiki.js source build failed: ${err.message ?? err}`);
  console.error('If you lack a C/C++ toolchain, fall back to: mise run tjs-setup');
  process.exit(1);
}
