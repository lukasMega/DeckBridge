#!/usr/bin/env node
// Build every extension in src/extensions/<id>/ into dist/extensions/<id>/:
//   manifest.json  copied as-is
//   server.js      ES module for the extension worker (txiki.js)
//   ui.js          ES module the WebUI import()s; Preact comes from the host (preact-shim.ts)
// Usage: node scripts/build-extensions.mjs [--only <id>]
import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = path.join(root, 'src/extensions');
const outRoot = path.join(root, 'dist/extensions');
const shim = path.join(srcRoot, 'sdk/preact-shim.ts');
const onlyAt = process.argv.indexOf('--only');
const only = onlyAt > 0 ? process.argv[onlyAt + 1] : undefined;

const ids = readdirSync(srcRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(path.join(srcRoot, e.name, 'manifest.json')))
  .map((e) => e.name)
  .filter((id) => only === undefined || id === only);
if (ids.length === 0) throw new Error(`no extension to build${only ? `: ${only}` : ''}`);

for (const id of ids) {
  const src = path.join(srcRoot, id);
  const out = path.join(outRoot, id);
  const manifest = JSON.parse(readFileSync(path.join(src, 'manifest.json'), 'utf8'));
  if (manifest.id !== id) throw new Error(`${id}/manifest.json: id must be "${id}"`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  copyFileSync(path.join(src, 'manifest.json'), path.join(out, 'manifest.json'));

  await build({
    entryPoints: [path.join(src, 'server.ts')],
    outfile: path.join(out, 'server.js'),
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'neutral',
    target: 'esnext',
    external: ['tjs', 'tjs:*'],
    logLevel: 'warning',
  });

  if (existsSync(path.join(src, 'ui.tsx'))) {
    await build({
      entryPoints: [path.join(src, 'ui.tsx')],
      outfile: path.join(out, 'ui.js'),
      bundle: true,
      minify: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      jsx: 'automatic',
      jsxImportSource: 'preact',
      alias: { preact: shim, 'preact/hooks': shim, 'preact/jsx-runtime': shim },
      logLevel: 'warning',
    });
  }
  console.log(`extension → dist/extensions/${id} (v${manifest.version})`);
}
