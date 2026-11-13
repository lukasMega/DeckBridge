#!/usr/bin/env node
// Regenerate every app/tray icon from one vector source: the BridgeMark glyph
// (docs-site/src/pages/_home/BridgeMark.tsx) on a rounded-square gradient plate.
//
// Usage: node scripts/gen-icons.mjs   (mise run icons)
// Requires: rsvg-convert (brew install librsvg) — dev-only, icons are committed.
//
// Outputs:
//   src-tauri/icons/{32x32,128x128,128x128@2x,icon}.png + icon.ico   (app + exe resource)
//   rust/deckbridge-tray/icons/icon-{full,usb-only,disconnected}.png (22px tray states)
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const BRAND = { from: '#4a8cf2', to: '#4f74e0' };
const TRAY_STATES = {
  full: { from: '#34d399', to: '#16a34a' },
  'usb-only': { from: '#fbbf24', to: '#f59e0b' },
  disconnected: { from: '#9ca3af', to: '#6b7280' },
};

// BridgeMark in a 24-unit box: two rounded pads joined by a bar.
function svg({ from, to }, { plate = true, pad = 0 } = {}) {
  const mark = `
    <g transform="translate(${pad} ${pad}) scale(${(24 - 2 * pad) / 24})">
      <rect x="2" y="9" width="6" height="6" rx="1.5" fill="#fafcff"/>
      <rect x="16" y="9" width="6" height="6" rx="1.5" fill="#fafcff"/>
      <path d="M8 12h8" stroke="#fafcff" stroke-width="2" stroke-linecap="round"/>
    </g>`;
  const plateRect = plate ? `<rect width="24" height="24" rx="5.3" fill="url(#g)"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0.35" y2="1">
    <stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>
  </linearGradient></defs>
  ${plateRect}${mark}
</svg>`;
}

function render(source, size, outFile) {
  const tmp = join(root, 'dist', `icon-src-${size}.svg`);
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(tmp, source);
  execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), '-o', outFile, tmp]);
  return readFileSync(outFile);
}

// ICO container holding PNG entries (Vista+ format; what rcedit and Explorer expect).
function ico(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  let offset = 6 + entries.length * 16;
  const dir = [];
  for (const { size, png } of entries) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    dir.push(e);
    offset += png.length;
  }
  return Buffer.concat([header, ...dir, ...entries.map((e) => e.png)]);
}

const appDir = join(root, 'src-tauri', 'icons');
const trayDir = join(root, 'rust', 'deckbridge-tray', 'icons');
mkdirSync(appDir, { recursive: true });

const appSvg = svg(BRAND, { pad: 0 });
for (const [size, name] of [
  [32, '32x32.png'],
  [128, '128x128.png'],
  [256, '128x128@2x.png'],
  [512, 'icon.png'],
]) {
  render(appSvg, size, join(appDir, name));
  console.log(`app: ${name} (${size}px)`);
}

const icoEntries = [16, 32, 48, 64, 128, 256].map((size) => ({
  size,
  png: render(appSvg, size, join(root, 'dist', `ico-${size}.png`)),
}));
writeFileSync(join(appDir, 'icon.ico'), ico(icoEntries));
console.log(`app: icon.ico (${icoEntries.map((e) => e.size).join(', ')}px)`);

// Tray stays 22px: tray_icon sizes the macOS menubar image from the pixel buffer.
for (const [state, colors] of Object.entries(TRAY_STATES)) {
  render(svg(colors, { pad: 1.5 }), 22, join(trayDir, `icon-${state}.png`));
  console.log(`tray: icon-${state}.png (22px)`);
}

for (const size of [16, 22, 32, 48, 64, 128, 256, 512]) {
  rmSync(join(root, 'dist', `icon-src-${size}.svg`), { force: true });
  rmSync(join(root, 'dist', `ico-${size}.png`), { force: true });
}
