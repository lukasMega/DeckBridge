#!/usr/bin/env node
// Build a SLIM txiki.js runtime from source.
//
// This is the size-optimized alternative to scripts/tjs-download.mjs (which
// grabs the official prebuilt release). It clones lukasMega/txiki.js at
// $TXIKI_VERSION and configures it with -DBUILD_WITH_WASM=OFF
// -DBUILD_WITH_SQLITE=OFF (native upstream options as of v26.5.1 — no patch
// needed), builds a Release binary, strips it, and copies it to $TJS.
//
// The app uses NONE of sqlite/wasm — only tjs:ffi, raw TCP, and tjs.serve
// HTTP+WebSocket — so removing those subsystems shrinks the embedded runtime
// (and therefore the compiled `deckbridge` binary, which self-embeds it).
//
// Requires: git, cmake, a C/C++ toolchain (cc/clang/gcc), make, libffi.
// Opt in via `mise run tjs-build` (or TJS_FROM_SOURCE=1; see mise.toml).
//
// Env (same contract as tjs-download.mjs):
//   TJS            destination path for the runtime binary (vendor/.../build/tjs)
//   TXIKI_VERSION  git tag to build (e.g. v26.5.1)

import { execSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, chmodSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform, cpus } from 'node:os';

const { TJS, TXIKI_VERSION } = process.env;

if (!TJS || !TXIKI_VERSION) {
  console.error('TJS and TXIKI_VERSION env vars must be set');
  process.exit(1);
}

if (existsSync(TJS)) {
  console.log(`tjs already present: ${TJS}`);
  process.exit(0);
}

const isWin = platform() === 'win32';

// Repo root is the parent of this script's scripts/ directory.
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

// --- Toolchain preflight: fail with an actionable message, not a build error ---
function have(cmd) {
  try {
    execSync(`${isWin ? 'where' : 'command -v'} ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const missing = ['git', 'cmake'].filter((c) => !have(c));
// Need at least one C compiler. (cmake also needs a working toolchain, but this
// gives a clearer hint than a mid-configure failure.)
if (!isWin && !['cc', 'clang', 'gcc'].some(have)) missing.push('a C/C++ compiler (cc/clang/gcc)');
if (!isWin && !have('make')) missing.push('make');

if (missing.length) {
  console.error(
    [
      `Cannot build txiki.js from source: missing ${missing.join(', ')}.`,
      '',
      'The slim source build needs git + cmake + make + a C/C++ toolchain.',
      '  macOS:  xcode-select --install && brew install cmake libffi',
      '  Debian: sudo apt-get install -y build-essential cmake git libffi-dev',
      '',
      'No toolchain? Use the prebuilt runtime instead:  mise run tjs-setup',
    ].join('\n'),
  );
  process.exit(1);
}

// Build into a dedicated dir next to the destination so we never clobber an
// existing working runtime until the slim build is proven to exist.
const buildRoot = join(repoRoot, 'vendor', 'txiki.js-src');
const srcDir = join(buildRoot, TXIKI_VERSION);
const buildDir = join(srcDir, 'build');
const builtTjs = join(buildDir, isWin ? 'tjs.exe' : 'tjs');

function run(cmd, opts = {}) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', ...opts });
}

try {
  // Fresh checkout each run keeps the build deterministic.
  rmSync(srcDir, { recursive: true, force: true });
  mkdirSync(buildRoot, { recursive: true });

  console.log(`Cloning lukasMega/txiki.js @ ${TXIKI_VERSION} ...`);
  run(`git clone --depth 1 --branch "${TXIKI_VERSION}" https://github.com/lukasMega/txiki.js "${srcDir}"`);

  // BUILD_WITH_WASM=OFF/BUILD_WITH_SQLITE=OFF below compile those subsystems
  // out entirely, so deps/wamr and deps/sqlite3 (a plain vendored dir, not a
  // submodule) are never built — but recursing all submodules is harmless. We
  // init everything for robustness (mbedtls/quickjs/libuv/mimalloc/
  // libwebsockets are all needed). test262 (a quickjs sub-submodule) is huge
  // and skipped by upstream's .gitmodules `update = none`-style config;
  // --recursive honors that.
  console.log('Initializing submodules (this can take a minute) ...');
  run('git submodule update --init --recursive --depth 1', { cwd: srcDir });

  // -DBUILD_WITH_WASM=OFF / -DBUILD_WITH_SQLITE=OFF are native upstream CMake
  // options (as of v26.5.1) that compile out WAMR/wasm and sqlite3 entirely —
  // this app uses neither (see file header). No source patch needed.
  const cmakeArgs = [
    '-B', buildDir,
    '-DCMAKE_BUILD_TYPE=Release',
    '-DBUILD_WITH_MIMALLOC=ON',
    '-DBUILD_WITH_WASM=OFF',
    '-DBUILD_WITH_SQLITE=OFF',
  ];

  // On macOS, libffi normally resolves from the Command Line Tools SDK
  // (.../usr/include/ffi/ffi.h + libffi.tbd) — cmake's REQUIRED
  // find_library/find_path locate it with no help. Only when a Homebrew libffi
  // keg actually ships BOTH the lib AND the header do we hint it; we never pass
  // a half-hint (lib without a matching ffi.h) because that would override the
  // working SDK auto-detection with a broken include path.
  if (platform() === 'darwin') {
    try {
      const ffiPrefix = execSync('brew --prefix libffi', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
      const ffiLib = join(ffiPrefix, 'lib', 'libffi.dylib');
      const ffiHeader = join(ffiPrefix, 'include', 'ffi.h');
      if (existsSync(ffiLib) && existsSync(ffiHeader)) {
        cmakeArgs.push(`-DFFI_LIB=${ffiLib}`, `-DFFI_INCLUDE_DIR=${join(ffiPrefix, 'include')}`);
      }
      // Otherwise: let cmake auto-detect (SDK libffi).
    } catch {
      // brew not present — let cmake use its default search paths.
    }
  }

  console.log('Configuring (cmake) ...');
  execFileSync('cmake', cmakeArgs, { stdio: 'inherit', cwd: srcDir });

  const jobs = Math.max(1, cpus().length);

  // No source patch means no bundle regeneration step: the JS bootstrap
  // bundles committed in the tag already match the checked-out C/JS sources,
  // so a single direct build is enough (unlike the old patch-based flow,
  // which had to rebuild tjsc + regenerate bundles from the patched sources).
  console.log(`Building tjs runtime (cmake --build, -j ${jobs}) ...`);
  execFileSync('cmake', ['--build', buildDir, '-j', String(jobs)], { stdio: 'inherit', cwd: srcDir });

  if (!existsSync(builtTjs)) {
    console.error(`Build finished but ${builtTjs} not found`);
    process.exit(1);
  }

  // Smoke-test that the freshly built runtime actually boots before we install
  // it (catches a broken build rather than shipping a dead binary).
  console.log('Smoke-testing the slim runtime ...');
  const probe = execFileSync(builtTjs, ['eval', 'console.log(typeof tjs)'], { encoding: 'utf8' }).trim();
  if (probe !== 'object') {
    console.error(`Slim runtime smoke test failed: expected "object", got "${probe}"`);
    process.exit(1);
  }

  // Strip debug + non-global symbols (~355 KB on macOS). Skip on Windows.
  if (!isWin) {
    console.log('Stripping symbols (strip -S -x) ...');
    run(`strip -S -x "${builtTjs}"`);
  }

  // Only now that we have a proven slim binary, install it to $TJS.
  mkdirSync(dirname(TJS), { recursive: true });
  copyFileSync(builtTjs, TJS);
  chmodSync(TJS, 0o755);
  console.log(`slim tjs installed: ${TJS}`);
} catch (err) {
  console.error(`\ntxiki.js source build failed: ${err.message ?? err}`);
  console.error('If you lack a C/C++ toolchain, fall back to: mise run tjs-setup');
  process.exit(1);
}
