#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, chmodSync, rmSync, copyFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir, platform, arch } from 'node:os';

const { TJS, TXIKI_VERSION } = process.env;

if (!TJS || !TXIKI_VERSION) {
  console.error('TJS and TXIKI_VERSION env vars must be set');
  process.exit(1);
}

if (existsSync(TJS)) {
  console.log(`tjs already present: ${TJS}`);
  process.exit(0);
}

const OS_MAP = { darwin: 'macos', linux: 'linux', win32: 'windows' };
const ARCH_MAP = { x64: 'x86_64', arm64: 'arm64' };

const isWin = platform() === 'win32';
const osName = OS_MAP[platform()];
const archName = ARCH_MAP[arch()];

if (!osName) { console.error(`Unsupported OS: ${platform()}`); process.exit(1); }
if (!archName) { console.error(`Unsupported arch: ${arch()}`); process.exit(1); }

const zip = `txiki-${osName}-${archName}.zip`;
const url = `https://github.com/saghul/txiki.js/releases/download/${TXIKI_VERSION}/${zip}`;
const tmp = join(tmpdir(), `tjs-download-${Date.now()}`);
const binName = isWin ? 'tjs.exe' : 'tjs';

console.log(`Downloading ${url}...`);

// Recursively finds every file under `dir` named `name` — a node-native stand-in
// for `find` (not available on a stock Windows box).
function findFiles(dir, name) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findFiles(full, name));
    else if (entry.name === name) found.push(full);
  }
  return found;
}

try {
  mkdirSync(tmp, { recursive: true });
  const zipPath = join(tmp, zip);
  const outDir = join(tmp, 'out');

  // node-native fetch instead of curl — Node 24 (this project's pinned tool)
  // ships a global fetch, and it works identically on every platform, so this
  // replaces the curl shell-out everywhere rather than adding a third branch.
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`Download failed: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));

  mkdirSync(outDir, { recursive: true });
  if (isWin) {
    // Expand-Archive is Windows' built-in unzip — there's no `unzip` binary on a
    // stock Windows box (Git Bash on GitHub's windows-latest runners is not
    // assumed here; this script runs under plain node/cmd).
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${outDir}' -Force"`,
      { stdio: 'inherit' },
    );
  } else {
    execSync(`unzip -q "${zipPath}" -d "${outDir}"`, { stdio: 'inherit' });
  }

  const found = isWin
    ? findFiles(outDir, binName)[0]
    : execSync(`find "${outDir}" -name "${binName}" -type f`).toString().trim().split('\n').filter(Boolean)[0];
  if (!found) { console.error(`${binName} binary not found in zip`); process.exit(1); }

  mkdirSync(dirname(TJS), { recursive: true });
  if (isWin) {
    copyFileSync(found, TJS);
  } else {
    execSync(`cp "${found}" "${TJS}"`);
  }
  chmodSync(TJS, 0o755);

  // Strip debug + non-global symbols (~355 KB smaller; the runtime still runs).
  // macOS/Linux only — Windows has no `strip` and the prebuilt is a .exe.
  if (!isWin) {
    try {
      execSync(`strip -S -x "${TJS}"`, { stdio: 'inherit' });
    } catch {
      console.warn('warning: strip failed (continuing with unstripped binary)');
    }
  }

  console.log(`tjs installed: ${TJS}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
