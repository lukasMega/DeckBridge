#!/usr/bin/env node
// Stamps ts/package.json's version into every file that needs a real version
// number burned in at build time (Cargo crate metadata, Tauri app version).
// Run in CI only, right before the versioned build steps — the result is
// never committed, so these files stay at whatever placeholder is checked in.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(resolve(root, 'ts/package.json'), 'utf8')).version;

const cargoFiles = [
  'src-tauri/Cargo.toml',
  'rust/deckbridge-native/Cargo.toml',
  'rust/deckbridge-tray/Cargo.toml',
];
for (const f of cargoFiles) {
  const p = resolve(root, f);
  const updated = readFileSync(p, 'utf8').replace(/^version = ".*"/m, `version = "${version}"`);
  writeFileSync(p, updated);
}

const tauriConfPath = resolve(root, 'src-tauri/tauri.conf.json');
const tauriConf = JSON.parse(readFileSync(tauriConfPath, 'utf8'));
tauriConf.version = version;
writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n');

console.log(`sync-version: stamped ${version} into ${cargoFiles.length + 1} files`);
