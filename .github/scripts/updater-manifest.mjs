// Writes <dir>/latest.json, the static manifest the Tauri updater polls
// (plugins.updater.endpoints in src-tauri/tauri.conf.json).
// Usage: node updater-manifest.mjs <artifacts-dir> <tag, e.g. deckbridge-v1.2.3>
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, tag] = process.argv.slice(2);
if (!dir || !tag?.startsWith('deckbridge-v')) {
  console.error('usage: updater-manifest.mjs <artifacts-dir> deckbridge-vX.Y.Z');
  process.exit(2);
}

// Tauri platform key -> release asset name (release.yml renames the macOS bundles per arch).
const PLATFORMS = {
  'darwin-aarch64': (f) => f === 'DeckBridge-macos-arm64.app.tar.gz',
  'darwin-x86_64': (f) => f === 'DeckBridge-macos-x86_64.app.tar.gz',
  'windows-x86_64': (f) => f.endsWith('_x64-setup.exe'),
};

const files = readdirSync(dir);
const platforms = {};
for (const [key, match] of Object.entries(PLATFORMS)) {
  const asset = files.find(match);
  // An incomplete manifest would leave that platform's installed apps on the old version.
  if (!asset || !files.includes(`${asset}.sig`)) {
    console.error(`updater-manifest: missing ${key} bundle or its .sig in ${dir}`);
    process.exit(1);
  }
  platforms[key] = {
    signature: readFileSync(join(dir, `${asset}.sig`), 'utf8').trim(),
    url: `https://github.com/lukasMega/DeckBridge/releases/download/${tag}/${encodeURIComponent(asset)}`,
  };
}

const manifest = {
  version: tag.slice('deckbridge-v'.length),
  pub_date: new Date().toISOString(),
  platforms,
};
writeFileSync(join(dir, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
