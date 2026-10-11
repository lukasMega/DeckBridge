#!/usr/bin/env node
// Zip each built extension (ts/dist/extensions/<id>/) as its own release asset.
// Usage: node scripts/package-extensions.mjs   (after `mise run extensions`)
//
// Outputs: dist/deckbridge-ext-<id>-v<version>.zip, holding one <id>/ folder: unzip it
// into the extensions dir (docs/extensions.md). The version is the extension's own;
// compatibility is the manifest's apiVersion, not the DeckBridge version.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const built = join(root, 'ts/dist/extensions');
const distRoot = join(root, 'dist');

if (!existsSync(built)) {
  console.error("error: no built extensions — run 'mise run extensions' first");
  process.exit(1);
}
mkdirSync(distRoot, { recursive: true });

for (const id of readdirSync(built)) {
  const manifest = JSON.parse(readFileSync(join(built, id, 'manifest.json'), 'utf8'));
  const zipFile = join(distRoot, `deckbridge-ext-${id}-v${manifest.version}.zip`);
  rmSync(zipFile, { force: true });
  // -9 max deflate, -X no macOS extended attributes; cwd keeps <id>/ as the top folder.
  const zip = spawnSync('zip', ['-9', '-qrX', zipFile, id], { cwd: built, stdio: 'inherit' });
  if (zip.status !== 0 || !existsSync(zipFile)) {
    console.error(`error: ${zipFile} was not created`);
    process.exit(1);
  }
  console.log(`Created: ${zipFile}`);
}
