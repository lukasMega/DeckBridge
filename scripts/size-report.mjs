#!/usr/bin/env node
// Size report for the release payload: esbuild metafile per bundle, minified CSS, web/client
// LOC, and (when built) the compiled binary minus the runtime. Needs no native build.
// `tjs compile` stores the bundle as deflate-compressed bytecode, so gzip -9 is the proxy
// for binary cost. Usage: node scripts/size-report.mjs [--json] [--top=N] [--unmangled]
//
// The esbuild options below mirror ts/build.mjs (simple-only, non-mock release config), and the
// ui.js / ui CSS numbers are the SHIPPED form, class names mangled by the same module build.mjs
// uses (ts/scripts/class-mangle.mjs); `--unmangled` reports the readable form instead.
// Keep the options in sync when build.mjs changes.
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { mangleClasses } from '../ts/scripts/class-mangle.mjs';

const ROOT = join(import.meta.dirname, '..');
const TS = join(ROOT, 'ts');
const CLIENT = join(TS, 'src/web/client');
const { build, transform } = createRequire(join(TS, 'package.json'))('esbuild');

const DECK_JS_TARGETS = ['es2017', 'chrome80', 'firefox78', 'edge80'];
const DECK_CSS_TARGETS = ['safari12', 'ios12', 'chrome80', 'firefox78', 'edge80'];
const version = JSON.parse(readFileSync(join(TS, 'package.json'), 'utf8')).version;

const gz = (bytes) => gzipSync(bytes, { level: 9 }).length;

const clientDefine = {
  'process.env.NODE_ENV': '"production"',
  __DEMO__: 'false',
  __SIMPLE_ONLY__: 'true',
  __MOCK_BUILD__: 'false',
  __VERSION__: JSON.stringify(version),
};
const clientBase = {
  bundle: true,
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  define: clientDefine,
};
const shared = {
  bundle: true,
  platform: 'neutral',
  target: 'esnext',
  supported: { decorators: false },
  format: 'esm',
  alias: {
    'node:events': './src/platform/events-shim.ts',
    events: './src/platform/events-shim.ts',
    'node:buffer': './src/platform/buffer-shim.ts',
  },
  inject: ['./src/platform/buffer-shim.ts'],
  external: ['tjs', 'tjs:*'],
  define: {
    global: 'globalThis',
    'process.env.NODE_ENV': '"production"',
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __LOG_LEVEL__: '1',
    __VERSION__: JSON.stringify(version),
    __DEMO__: 'false',
    __SIMPLE_ONLY__: 'true',
    __MOCK_BUILD__: 'false',
  },
  loader: { '.html': 'text', '.css': 'text' },
};

// Copy of ts/build.mjs minifyHtml.
function minifyHtml(src) {
  const protectedBlocks = [];
  let html = src.replace(/<(script|style|pre)\b[^>]*>[\s\S]*?<\/\1>/gi, (m) => {
    protectedBlocks.push(m);
    return ` HTMLPROTECT${protectedBlocks.length - 1} `;
  });
  // Repeat until stable so nested comment fragments cannot reassemble.
  for (let prev = ''; prev !== html;) {
    prev = html;
    html = html.replace(/<!--[\s\S]*?-->/g, '');
  }
  html = html
    .replace(/>\s+</g, '><')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return html.replace(/ HTMLPROTECT(\d+) /g, (_, i) => protectedBlocks[Number(i)]);
}

// Minifies like build.mjs's minifyTextAssets. CSS is measured on its own below, so the
// bundles that import it (main) get an empty string and are not double-counted.
const textAssets = (cssAsEmpty) => ({
  name: 'text-assets',
  setup(b) {
    b.onLoad({ filter: /\.css$/ }, () => (cssAsEmpty ? { contents: '', loader: 'text' } : null));
    b.onLoad({ filter: /\.html$/ }, (args) => ({
      contents: minifyHtml(readFileSync(args.path, 'utf8')),
      loader: 'text',
    }));
  },
});
// ui.js / deck.js are stubs build.mjs replaces with the real client bundle; measured separately.
const clientStubs = {
  name: 'client-stubs',
  setup(b) {
    b.onLoad({ filter: /client[/\\](deck[/\\])?(ui|deck)\.js$/ }, () => ({
      contents: '',
      loader: 'text',
    }));
  },
};
// build.mjs does the same: release bundles never carry the mock driver.
const noMockDriver = {
  name: 'no-mock-driver',
  setup(b) {
    b.onResolve({ filter: /[/\\]devices[/\\]mock\.js$/ }, () => ({
      path: 'mock-driver',
      namespace: 'release-stub',
    }));
    b.onLoad({ filter: /.*/, namespace: 'release-stub' }, () => ({
      contents: 'export const MockDriver = undefined;',
      loader: 'js',
    }));
  },
};

async function bundle(opts) {
  const r = await build({
    absWorkingDir: TS,
    write: false,
    metafile: true,
    minify: true,
    logLevel: 'silent',
    ...opts,
  });
  const out = r.outputFiles[0].contents;
  const inputs = {};
  const meta = Object.values(r.metafile.outputs)[0];
  for (const [k, v] of Object.entries(meta.inputs)) {
    if (v.bytesInOutput > 0) inputs[inputKey(k)] = (inputs[inputKey(k)] ?? 0) + v.bytesInOutput;
  }
  return { raw: out.length, gzip: gz(out), inputs, text: r.outputFiles[0].text };
}

// pnpm's nested paths collapse to "node_modules/preact/..."; repo paths lose the "src/" prefix.
function inputKey(k) {
  const i = k.lastIndexOf('node_modules/');
  return i >= 0 ? k.slice(i) : k.replace(/^src\//, '');
}

function groupOf(key) {
  const p = key.split('/');
  if (p[0] !== 'node_modules') return p.slice(0, -1).join('/');
  return p.slice(0, p[1].startsWith('@') ? 3 : 2).join('/');
}

const WORKERS = {
  'hid-worker': 'src/worker/hid-worker.ts',
  'hid-scan-worker': 'src/worker/hid-scan-worker.ts',
  'plugin-worker': 'src/plugin/plugin-worker.ts',
};
const CSS_FILES = ['ui-base.css', 'ui-simple.css', 'deck/deck.css'];

// Counts `prop: value` declarations in minified CSS (nested at-rules included).
function cssDeclarations(css) {
  const out = [];
  let buf = '';
  let paren = 0;
  let quote = '';
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (quote) {
      buf += c;
      if (c === '\\') buf += css[++i] ?? '';
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') paren++;
    else if (c === ')') paren--;
    else if (paren === 0 && c === '{') {
      buf = '';
      continue;
    } else if (paren === 0 && (c === ';' || c === '}')) {
      if (buf.includes(':') && !buf.startsWith('@')) out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += c;
  }
  return out;
}

// `uiText` is the built ui.js; with `mangle` the ui CSS files are returned in their shipped,
// class-mangled form (`mangled` holds the matching ui.js and the stats).
async function measureCss(uiText, mangle) {
  const files = [];
  const plain = {};
  const srcs = {};
  for (const name of CSS_FILES) {
    srcs[name] = readFileSync(join(CLIENT, name), 'utf8');
    const { code } = await transform(srcs[name], {
      loader: 'css',
      minify: true,
      ...(name.startsWith('deck/') ? { target: DECK_CSS_TARGETS } : {}),
    });
    plain[name] = code;
  }
  const uiNames = CSS_FILES.slice(0, 2);
  const mangled = mangle
    ? mangleClasses(
        uiNames.map((name) => plain[name]),
        uiText,
      )
    : null;
  const minified = { ...plain };
  if (mangled) uiNames.forEach((name, i) => (minified[name] = mangled.css[i]));
  for (const name of CSS_FILES) {
    const code = minified[name];
    const decls = cssDeclarations(code);
    files.push({
      name,
      srcBytes: Buffer.byteLength(srcs[name]),
      srcLines: srcs[name].split('\n').length - 1,
      raw: Buffer.byteLength(code),
      gzip: gz(code),
      declarations: decls.length,
      uniqueDeclarations: new Set(decls).size,
    });
  }
  // assets.ts serves base + simple as one /ui.css, so they gzip together.
  const ui = uiNames.map((name) => minified[name]);
  const uiDecls = ui.flatMap(cssDeclarations);
  const plainUi = uiNames.map((name) => plain[name]).join('');
  return {
    files,
    mangled,
    unmangledUi: { raw: Buffer.byteLength(plainUi), gzip: gz(plainUi) },
    raw: files.reduce((s, f) => s + f.raw, 0),
    gzip: files.reduce((s, f) => s + f.gzip, 0),
    uiServedGzip: gz(ui.join('')),
    srcLines: files.reduce((s, f) => s + f.srcLines, 0),
    srcBytes: files.reduce((s, f) => s + f.srcBytes, 0),
    uiDeclarations: uiDecls.length,
    uiUniqueDeclarations: new Set(uiDecls).size,
  };
}

// Newline count (wc -l) over web/client .ts/.tsx incl. .d.ts; advanced/ is not shipped.
function measureLoc() {
  const loc = { shipped: 0, advanced: 0, files: 0 };
  const walk = (dir, advanced) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, advanced || (dir === CLIENT && e.name === 'advanced'));
      else if (/\.tsx?$/.test(e.name)) {
        const lines = readFileSync(p, 'utf8').split('\n').length - 1;
        loc[advanced ? 'advanced' : 'shipped'] += lines;
        if (!advanced) loc.files++;
      }
    }
  };
  walk(CLIENT, false);
  return loc;
}

function measureBinary() {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const binary = join(ROOT, `deckbridge${exe}`);
  const runtime = process.env.TJS ?? join(ROOT, `vendor/txiki.js/build/tjs${exe}`);
  if (!existsSync(binary) || !existsSync(runtime)) return null;
  const b = statSync(binary).size;
  const r = statSync(runtime).size;
  return { binary: b, runtime: r, runtimePath: runtime, payload: b - r };
}

// Informational: the libs build.mjs embeds as raw latin1 strings (needs a native build to exist).
// The bytecode deflate is what costs binary bytes, so gzip -9 of the raw file is the proxy.
function measureNativeLibs() {
  const ext = { darwin: 'dylib', win32: 'dll' }[process.platform] ?? 'so';
  const cands = [
    process.env.DECKBRIDGE_NATIVE_LIB ??
      join(ROOT, 'rust/target/release', `libdeckbridge_native.${ext}`),
    process.env.HIDAPI_LIB ?? '/opt/homebrew/opt/hidapi/lib/libhidapi.dylib',
  ].filter(existsSync);
  const libs = cands.map((p) => {
    const raw = readFileSync(p);
    return { name: p.split(/[/\\]/).pop(), raw: raw.length, gzip: gz(raw) };
  });
  return libs.length ? libs : null;
}

// Generated assets built alone, so their embedded-string cost shows even where a bundle
// tree-shakes part of them.
function measureAssets() {
  const dir = join(TS, 'src/assets');
  return Promise.all(
    readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .map(async (f) => {
        const r = await bundle({
          entryPoints: [join(dir, f)],
          bundle: true,
          format: 'esm',
          platform: 'neutral',
          target: 'esnext',
          charset: 'utf8',
        });
        return { name: f, raw: r.raw, gzip: r.gzip };
      }),
  );
}

// `mangle` (default) reports the shipped form: ui.js and the ui CSS with mangled class names.
export async function measure({ mangle = true } = {}) {
  // The mangler needs the ui.js text and the CSS, so it is built before the rest.
  const ui = await bundle({
    ...clientBase,
    entryPoints: [join(CLIENT, 'ui-entry.ts')],
    target: 'esnext',
  });
  const [deck, main, css, ...workers] = await Promise.all([
    bundle({
      ...clientBase,
      entryPoints: [join(CLIENT, 'deck/deck-entry.ts')],
      target: DECK_JS_TARGETS,
    }),
    bundle({
      ...shared,
      // As in build.mjs: the latin1 atlas strings stay raw UTF-8 instead of \xNN escapes.
      charset: 'utf8',
      entryPoints: [join(TS, 'src/main/app.ts')],
      external: [...shared.external, 'virtual:*'],
      plugins: [clientStubs, noMockDriver, textAssets(true)],
    }),
    measureCss(ui.text, mangle),
    ...Object.values(WORKERS).map((entry) =>
      bundle({
        ...shared,
        entryPoints: [join(TS, entry)],
        plugins: [clientStubs, textAssets(false)],
      }),
    ),
  ]);
  const unmangledUiJs = { raw: ui.raw, gzip: ui.gzip };
  if (css.mangled) {
    ui.raw = Buffer.byteLength(css.mangled.js);
    ui.gzip = gz(css.mangled.js);
  }
  const bundles = { 'ui.js': ui, 'deck.js': deck };
  for (const b of Object.values(bundles)) delete b.text;
  Object.keys(WORKERS).forEach((name, i) => (bundles[name] = workers[i]));
  bundles.main = main;
  const leaks = {};
  for (const name of Object.keys(WORKERS)) {
    const overlap = Object.entries(bundles[name].inputs)
      .filter(([k]) => k in main.inputs)
      .sort((a, b) => b[1] - a[1]);
    leaks[name] = { bytes: overlap.reduce((s, [, b]) => s + b, 0), top: overlap.slice(0, 8) };
  }
  return {
    version,
    mangle: css.mangled
      ? { ...css.mangled.stats, unmangledUiJs, unmangledUiCss: css.unmangledUi }
      : null,
    bundles,
    css: (({ mangled, unmangledUi, ...rest }) => rest)(css),
    loc: measureLoc(),
    workerSharedWithMain: leaks,
    workersRaw: workers.reduce((s, w) => s + w.raw, 0),
    workersGzip: workers.reduce((s, w) => s + w.gzip, 0),
    binary: measureBinary(),
    assets: await measureAssets(),
    nativeLibs: measureNativeLibs(),
  };
}

const n = (v) => v.toLocaleString('en-US');
const col = (v, w) => String(v).padStart(w);

function print(m, top) {
  const { bundles, css } = m;
  const row = (label, raw, gzip) => `  ${label.padEnd(34)}${col(n(raw), 11)}${col(n(gzip), 11)}`;
  const form = m.mangle ? 'shipped form: ui class names mangled' : 'class names NOT mangled';
  console.log(`DeckBridge size report (v${m.version}, simple-only release config, ${form})\n`);
  console.log(`  ${'part'.padEnd(34)}${col('raw (min)', 11)}${col('gzip -9', 11)}`);
  const tag = m.mangle ? ' (shipped, mangled)' : '';
  console.log(row(`ui.js${tag}`, bundles['ui.js'].raw, bundles['ui.js'].gzip));
  console.log(row('deck.js', bundles['deck.js'].raw, bundles['deck.js'].gzip));
  for (const name of Object.keys(WORKERS))
    console.log(row(name, bundles[name].raw, bundles[name].gzip));
  console.log(row('workers total', m.workersRaw, m.workersGzip));
  console.log(row('main (excl. workers/client/CSS)', bundles.main.raw, bundles.main.gzip));
  for (const [i, f] of css.files.entries())
    console.log(row(`css ${f.name}${m.mangle && i < 2 ? ' (mangled)' : ''}`, f.raw, f.gzip));
  console.log(row('css total', css.raw, css.gzip));
  console.log(`  (ui.css as served, base+simple gzipped together: ${n(css.uiServedGzip)})`);
  if (m.mangle) {
    const { classes, mangled, kept, stray, prefix, unmangledUiJs, unmangledUiCss } = m.mangle;
    console.log(
      `  class mangling: ${classes} classes, ${mangled} renamed, ${kept} kept (${stray} stray, ${prefix} dynamic)`,
    );
    console.log(row('  ui.js unmangled', unmangledUiJs.raw, unmangledUiJs.gzip));
    console.log(row('  ui CSS unmangled (base+simple)', unmangledUiCss.raw, unmangledUiCss.gzip));
  }

  console.log('\nWorker inputs also bundled into main (leak detector):');
  for (const [name, l] of Object.entries(m.workerSharedWithMain)) {
    console.log(`  ${name}: ${n(l.bytes)} B of ${n(bundles[name].raw)}`);
    for (const [k, b] of l.top.slice(0, 5)) console.log(`      ${col(n(b), 9)}  ${k}`);
  }

  for (const name of ['ui.js', 'deck.js', ...Object.keys(WORKERS), 'main']) {
    const inputs = Object.entries(bundles[name].inputs).sort((a, b) => b[1] - a[1]);
    const note = name === 'ui.js' && m.mangle ? ', before class mangling' : '';
    console.log(`\nTop ${top} inputs, ${name} (minified bytes${note}):`);
    for (const [k, b] of inputs.slice(0, top)) console.log(`  ${col(n(b), 9)}  ${k}`);
    if (name === 'ui.js' || name === 'deck.js') {
      const groups = {};
      for (const [k, b] of inputs) groups[groupOf(k)] = (groups[groupOf(k)] ?? 0) + b;
      const top6 = Object.entries(groups).sort((a, b) => b[1] - a[1]);
      console.log(
        `  by folder: ${top6
          .slice(0, 6)
          .map(([g, b]) => `${g.replace('web/client', 'client')} ${n(b)}`)
          .join(', ')}`,
      );
    }
  }

  console.log('\nSource:');
  console.log(
    `  web/client .ts/.tsx LOC (shipped, excl. advanced/): ${n(m.loc.shipped)} in ${m.loc.files} files`,
  );
  console.log(`  advanced/ LOC (not shipped): ${n(m.loc.advanced)}`);
  console.log(
    `  CSS lines (ui-base + ui-simple + deck): ${n(css.srcLines)} (${css.files.map((f) => `${f.name} ${n(f.srcLines)}`).join(', ')})`,
  );
  console.log(
    `  CSS source bytes: ${n(css.srcBytes)} (${css.files.map((f) => `${f.name} ${n(f.srcBytes)}`).join(', ')})`,
  );
  console.log(
    `  CSS declarations, ui-base + ui-simple: ${n(css.uiDeclarations)}, unique: ${n(css.uiUniqueDeclarations)}`,
  );
  console.log(`  CSS declarations, deck: ${n(css.files[2].declarations)}`);

  console.log('\nGenerated assets, built alone (src/assets, never hand-edit):');
  for (const a of m.assets)
    console.log(`  ${a.name.padEnd(22)}${col(n(a.raw), 11)}${col(n(a.gzip), 11)}`);
  if (m.nativeLibs) {
    console.log('\nNative libs (info), embedded as raw latin1 strings:');
    for (const l of m.nativeLibs)
      console.log(
        `  ${l.name.padEnd(28)} raw ${n(l.raw)}  gzip ${n(l.gzip)} (~ cost in the binary)`,
      );
  }
  if (m.binary) {
    console.log(`\nBinary: ./deckbridge ${n(m.binary.binary)} B`);
    console.log(`  runtime ${m.binary.runtimePath}: ${n(m.binary.runtime)} B`);
    console.log(`  binary - runtime (compiled payload): ${n(m.binary.payload)} B`);
  } else {
    console.log('\nBinary: ./deckbridge or the runtime ($TJS) is missing; run `mise run compile`.');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const top = Number(args.find((a) => a.startsWith('--top='))?.slice(6) ?? 10);
  const m = await measure({ mangle: !args.includes('--unmangled') });
  if (args.includes('--json')) console.log(JSON.stringify(m, null, 2));
  else print(m, top);
}
