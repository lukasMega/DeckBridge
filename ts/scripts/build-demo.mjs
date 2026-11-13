import { build, transform } from 'esbuild';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFlag = process.argv.indexOf('--out');
const out = path.resolve(
  root,
  outFlag >= 0 ? process.argv[outFlag + 1] : '../docs-site/static/demo-app',
);
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
await mkdir(out, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ['src/demo/demo-entry.ts'],
  outfile: path.join(out, 'demo.js'),
  bundle: true,
  minify: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  alias: {
    'node:events': './src/platform/events-shim.ts',
    events: './src/platform/events-shim.ts',
    'node:buffer': './src/platform/buffer-shim.ts',
  },
  // browser-shims routes the WebUI's fetch/WebSocket to the in-browser backend.
  inject: ['./src/platform/buffer-shim.ts', './src/demo/browser-shims.ts'],
  define: {
    __SIMPLE_ONLY__: 'true',
    __MOCK_BUILD__: 'false',
    __DEMO__: 'true',
    __VERSION__: JSON.stringify(version),
    __LOG_LEVEL__: '2',
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    'process.env.NODE_ENV': '"production"',
    global: 'globalThis',
  },
});
const css = [];
for (const source of [
  'src/web/client/ui-base.css',
  'src/web/client/ui-simple.css',
  'src/demo/demo.css',
]) {
  css.push(
    (
      await transform(await readFile(path.join(root, source), 'utf8'), {
        loader: 'css',
        minify: true,
      })
    ).code,
  );
}
await writeFile(path.join(out, 'ui.css'), css.join(''));
const controlsCss = [
  (await readFile(path.join(root, 'src/web/client/ui-base.css'), 'utf8'))
    .replace(':root {', ':host {')
    .replace("html[data-theme='dark'] {", ":host([data-theme='dark']) {"),
  await readFile(path.join(root, 'src/demo/demo.css'), 'utf8'),
  ':host { font-family: var(--font); font-size: 14px; color: var(--fg); } :host .demo-panel { position: absolute; top: -4em; z-index: 99; }',
];
await writeFile(
  path.join(out, 'controls.css'),
  (await transform(controlsCss.join('\n'), { loader: 'css', minify: true })).code,
);
await writeFile(
  path.join(out, 'index.html'),
  await readFile(path.join(root, 'src/demo/index.html')),
);
for (const name of ['demo.js', 'ui.css', 'controls.css', 'index.html']) {
  console.log(`${name}: ${(await stat(path.join(out, name))).size} bytes`);
}
