#!/usr/bin/env node
// Build a distributable zip for the current platform.
// Usage: node scripts/package.mjs [version]
// Example: node scripts/package.mjs v1.2.3
//
// Outputs: dist/deckbridge-<version>-<platform>.zip
// Requires: mise run compile already done
//
// Env:
//   SRC_BIN       source binary to package (default "deckbridge"; "deckbridge-lite"
//                 for the simple-only build). Always renamed to `deckbridge` in the zip.
//   INCLUDE_TRAY  1 (default) bundles deckbridge-tray + status icons; 0 omits them.
import { execSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const die = (msg) => {
  console.error(msg);
  process.exit(1);
};

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, '..');

// --- Version ---
let version = process.argv[2];
if (!version) {
  const r = spawnSync('git', ['-C', root, 'describe', '--tags', '--exact-match'], { encoding: 'utf8' });
  version = r.status === 0 ? r.stdout.trim() : 'dev';
}

// --- Platform ---
const osMap = { darwin: { name: 'macos', lib: 'dylib' }, linux: { name: 'linux', lib: 'so' } };
const os = osMap[process.platform];
if (!os) die(`error: unsupported OS: ${process.platform}`);

const archMap = { x64: 'x86_64', arm64: 'arm64' };
const archName = archMap[process.arch];
if (!archName) die(`error: unsupported arch: ${process.arch}`);

// Source binary to package: deckbridge (full, default) or deckbridge-lite
// (simple-only, from `mise run compile-simple`). The in-zip binary is always
// named `deckbridge`, so runtime/tray/e2e behavior is identical either way.
const srcBin = process.env.SRC_BIN || 'deckbridge';

const platform = `${os.name}-${archName}`;
const distName = `${srcBin}-${version}-${platform}`;
const distRoot = join(root, 'dist');
const distDir = join(distRoot, distName);
const zipFile = join(distRoot, `${distName}.zip`);

// --- Verify build artifacts ---
const mainBin = join(root, srcBin);
const trayBin = join(root, 'rust', 'target', 'release', 'deckbridge-tray');
const iconsDir = join(root, 'rust', 'deckbridge-tray', 'icons');

// --- Optional system tray ---
// INCLUDE_TRAY=1 (default): bundle deckbridge-tray + status icons (full behavior).
// INCLUDE_TRAY=0: omit them for a ~1 MB smaller download. The app degrades
// gracefully (auto-detects deckbridge-tray next to the executable and runs without
// a tray when absent).
const includeTray = (process.env.INCLUDE_TRAY ?? '1') === '1';

// Artifacts that are always required; deckbridge-tray only when actually bundled.
const required = [mainBin, ...(includeTray ? [trayBin] : [])];
const missing = required.filter((f) => !existsSync(f));
if (missing.length) {
  for (const f of missing) console.error(`error: missing artifact: ${f}`);
  die("Run 'mise run compile' first.");
}

// --- Assemble ---
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

copyFileSync(mainBin, join(distDir, 'deckbridge'));
chmodSync(join(distDir, 'deckbridge'), 0o755);

if (includeTray) {
  copyFileSync(trayBin, join(distDir, 'deckbridge-tray'));
  for (const f of readdirSync(iconsDir).filter((f) => f.endsWith('.png'))) {
    copyFileSync(join(iconsDir, f), join(distDir, f));
  }
  chmodSync(join(distDir, 'deckbridge-tray'), 0o755);
  console.log('Including system tray: deckbridge-tray + icons');
} else {
  console.log('Excluding system tray (INCLUDE_TRAY=0): omitting deckbridge-tray + icons');
}

// Bundle third-party licenses (hidapi is embedded in the binary — license still required)
const licenseSrc = join(scriptDir, 'LICENSE-hidapi.txt');
if (existsSync(licenseSrc)) copyFileSync(licenseSrc, join(distDir, 'LICENSE-hidapi.txt'));

// --- Zip (primary artifact) ---
// -9: maximum deflate compression (smaller download).
// -X: exclude macOS extended attributes (resource forks) that cause warnings/non-zero exit
rmSync(zipFile, { force: true });
const zip = spawnSync('zip', ['-9', '-qrX', basename(zipFile), distName], { cwd: distRoot, stdio: 'inherit' });
if (zip.status !== 0 || !existsSync(zipFile)) die('error: zip was not created');
console.log(`Created: ${zipFile}`);

// --- Record zip size in bundle-sizes.csv ---
// build.mjs already appended this build's row with an empty trailing `zip` field
// (the zip didn't exist yet at bundle time). Fill in that field now by overwriting
// the last column of the final row. Idempotent: re-running package overwrites the
// same field instead of appending. Skipped if the CSV is absent.
const csv = join(root, 'bundle-sizes.csv');
if (existsSync(csv)) {
  const zipKb = (statSync(zipFile).size / 1024).toFixed(3);
  const text = readFileSync(csv, 'utf8');
  const trailingNl = text.endsWith('\n');
  const lines = text.split('\n');
  if (trailingNl) lines.pop();
  const cells = lines[lines.length - 1].split(',');
  cells[cells.length - 1] = ' ' + zipKb; // overwrite trailing zip field
  lines[lines.length - 1] = cells.join(',');
  writeFileSync(csv, lines.join('\n') + (trailingNl ? '\n' : ''));
  console.log(`Recorded zip size in bundle-sizes.csv: ${zipKb} kB`);
}

// --- Optional .tar.xz (secondary artifact) ---
// xz/LZMA compresses these binaries noticeably better than zip-deflate.
// Best-effort only: skip silently (never fail the build) if xz or tar are absent.
const tarxzFile = join(distRoot, `${distName}.tar.xz`);
const have = (cmd) => {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
if (have('xz') && have('tar')) {
  rmSync(tarxzFile, { force: true });
  try {
    execSync(`tar -cf - "${distName}" | xz -9 -c > "${basename(tarxzFile)}"`, { cwd: distRoot, stdio: 'inherit' });
    if (!existsSync(tarxzFile)) throw new Error('tar.xz missing');
    console.log(`Created: ${tarxzFile}`);
  } catch {
    console.error('warning: failed to create .tar.xz, continuing with .zip only');
    rmSync(tarxzFile, { force: true });
  }
} else {
  console.log('note: xz or tar not available — skipping .tar.xz (zip is the primary artifact)');
}

rmSync(distDir, { recursive: true, force: true });
