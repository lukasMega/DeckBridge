#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
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

const OS_MAP = { darwin: 'macos', linux: 'linux' };
const ARCH_MAP = { x64: 'x86_64', arm64: 'arm64' };

const osName = OS_MAP[platform()];
const archName = ARCH_MAP[arch()];

if (!osName) { console.error(`Unsupported OS: ${platform()}`); process.exit(1); }
if (!archName) { console.error(`Unsupported arch: ${arch()}`); process.exit(1); }

const zip = `txiki-${osName}-${archName}.zip`;
const url = `https://github.com/saghul/txiki.js/releases/download/${TXIKI_VERSION}/${zip}`;
const tmp = join(tmpdir(), `tjs-download-${Date.now()}`);

console.log(`Downloading ${url}...`);

try {
  mkdirSync(tmp, { recursive: true });
  execSync(`curl -fL "${url}" -o "${join(tmp, zip)}"`, { stdio: 'inherit' });
  execSync(`unzip -q "${join(tmp, zip)}" -d "${join(tmp, 'out')}"`, { stdio: 'inherit' });

  const found = execSync(`find "${join(tmp, 'out')}" -name "tjs" -type f`).toString().trim();
  if (!found) { console.error('tjs binary not found in zip'); process.exit(1); }

  mkdirSync(dirname(TJS), { recursive: true });
  execSync(`cp "${found}" "${TJS}"`);
  chmodSync(TJS, 0o755);

  // Strip debug + non-global symbols (~355 KB smaller; the runtime still runs).
  // macOS/Linux only — Windows has no `strip` and the prebuilt is a .exe.
  if (platform() !== 'win32') {
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
