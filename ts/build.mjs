import { build, transform } from 'esbuild';
import {
  statSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'fs';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createInstrumenter } from 'istanbul-lib-instrument';
import { cssClasses, mangleClasses, selectedClasses } from './scripts/class-mangle.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const isTest = process.argv.includes('--test');
const isSmoke = process.argv.includes('--smoke');
const isProbe = process.argv.includes('--probe');
const isCoverage = process.argv.includes('--coverage');
// Release builds exclude mock drivers and HTTP simulation routes. Opt in only
// for local mock runs and tests; keep their output separate from the release bundle.
const isMockBuild = process.env.DECKBRIDGE_BUILD_MOCK === '1';
// Simple-only is the DEFAULT build (and what ships in GitHub releases): the advanced
// (debug) view + its CSS are excluded from the embedded UI. esbuild constant-folds
// `__SIMPLE_ONLY__` and tree-shakes AdvancedApp/advanced CSS out.
// Opt back in with `--advanced` (or DECKBRIDGE_ADVANCED=1) for the debug-view build.
const isAdvanced = process.argv.includes('--advanced') || process.env.DECKBRIDGE_ADVANCED === '1';
const isSimpleOnly = !isAdvanced;
// Class-name mangling is part of the shipped release form only (ui.js + ui-base/ui-simple CSS):
// mock, test, probe and advanced builds keep the readable names, so e2e and the screenshots need
// no hooks. DECKBRIDGE_MANGLE_MOCK=1 mangles a mock build to verify the shipped form on demand
// (=all: also the classes e2e selects by, see e2eSelectedClasses); DECKBRIDGE_NO_MANGLE=1 turns
// mangling off (debugging in DevTools).
const mangleClassNames =
  isSimpleOnly &&
  !isTest &&
  !isSmoke &&
  !isProbe &&
  process.env.DECKBRIDGE_NO_MANGLE !== '1' &&
  (!isMockBuild || ['1', 'all'].includes(process.env.DECKBRIDGE_MANGLE_MOCK ?? ''));

// Native-lib embedding: on for normal bundle builds, off for test/smoke builds
// and when explicitly disabled (dev loop: EMBED_NATIVE_LIBS=0 or --no-embed).
const noEmbed =
  isTest || isSmoke || process.argv.includes('--no-embed') || process.env.EMBED_NATIVE_LIBS === '0';
const testName = isTest ? process.argv[process.argv.indexOf('--test') + 1] : null;
// `--probe` defaults to the K1 Pro probe; `--probe <name>` builds src/dev/<name>.ts instead
// (hardware probes are one dev entry each — see the dev-entry element in eslint.config.mjs).
const probeArg = isProbe ? process.argv[process.argv.indexOf('--probe') + 1] : null;
const probeName = probeArg && !probeArg.startsWith('--') ? probeArg : 'k1pro-probe';

let uiJsSize = 0;
let deckJsSize = 0;

const LOG_LEVEL_MAP = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };
const logLevelEnv = process.env.LOG_LEVEL ?? (isTest ? 'warn' : 'info');
const logLevel = LOG_LEVEL_MAP[logLevelEnv] ?? 1;
// Single source of truth for the version is package.json's "version" field
// (bump it there for a release); VERSION env stays as an override escape hatch.
const version =
  process.env.VERSION ?? JSON.parse(readFileSync(`${dir}/package.json`, 'utf8')).version;

let entryPoint = `${dir}/src/main/app.ts`;
if (isTest) entryPoint = path.resolve(dir, `test/${testName}.test.ts`);
else if (isSmoke) entryPoint = `${dir}/src/dev/mirabox-smoke.ts`;
else if (isProbe) entryPoint = `${dir}/src/dev/${probeName}.ts`;

let outfile = `${dir}/dist/bundle.js`;
if (isTest) outfile = path.resolve(dir, `dist/test/${testName}.js`);
else if (isSmoke) outfile = `${dir}/dist/mirabox-smoke.js`;
else if (isProbe) outfile = `${dir}/dist/${probeName}.js`;
else if (isMockBuild) outfile = `${dir}/dist/mock/bundle.js`;

// The browser deck page runs on old phones/tablets (iOS/iPadOS 12.2+ Safari, Android 7 Chrome 80+),
// so its JS and CSS are lowered to these targets. esbuild fails the build on syntax it cannot
// lower (e.g. regexp lookbehind); assertLegacySafe covers APIs, which esbuild never polyfills.
// JS stops at 'es2017': esbuild refuses to lower destructuring for any safari/ios target
// (a Safari<=14 bug workaround it cannot emulate), and es2017 is what iOS 12.2 supports natively
// after lowering object spread, optional catch binding and `?.`/`??`. CSS can name the browsers.
const DECK_JS_TARGETS = ['es2017', 'chrome80', 'firefox78', 'edge80'];
const DECK_CSS_TARGETS = ['safari12', 'ios12', 'chrome80', 'firefox78', 'edge80'];
const LEGACY_API_DENYLIST = [
  ['.at(', /\.at\(/],
  ['.toSorted(', /\.toSorted\(/],
  ['.toReversed(', /\.toReversed\(/],
  ['.findLast(', /\.findLast\(/],
  ['.replaceAll(', /\.replaceAll\(/],
  ['structuredClone', /structuredClone/],
  ['randomUUID', /randomUUID/],
  ['Object.hasOwn', /Object\.hasOwn/],
  ['ResizeObserver', /ResizeObserver/],
  ['Promise.allSettled', /Promise\.allSettled/],
  ['.flatMap(', /\.flatMap\(/],
  ['Object.fromEntries', /Object\.fromEntries/],
];

function assertLegacySafe(js, label) {
  for (const [name, re] of LEGACY_API_DENYLIST) {
    if (re.test(js)) throw new Error(`${label} uses ${name}, which the legacy browser targets lack`);
  }
}

const once = (fn) => {
  let result;
  return () => (result ??= fn());
};

// Bundles a browser-side entry subtree into a single IIFE string. Memoized: every esbuild call
// below (workers, main) loads the same client stubs, and the ui.js text also feeds the class mangler.
const clientSource = (entry, target) =>
  once(async () => {
    const result = await build({
      entryPoints: [path.resolve(dir, 'src/web/client', entry)],
      bundle: true,
      minify: true,
      platform: 'browser',
      target,
      format: 'iife',
      write: false,
      jsx: 'automatic',
      jsxImportSource: 'preact',
      define: {
        'process.env.NODE_ENV': '"production"',
        __DEMO__: 'false',
        __SIMPLE_ONLY__: JSON.stringify(isSimpleOnly),
        __MOCK_BUILD__: JSON.stringify(isMockBuild),
        __VERSION__: JSON.stringify(version),
      },
    });
    return result.outputFiles[0].text;
  });

// A stub .js file (ui.js, deck.js) is what server code imports; this plugin intercepts that load
// and embeds the real bundle (`source`, optionally post-processed by `rewrite`) as text instead.
function clientBundleAsText({ name, stubRe, source, rewrite, outFile, legacyCheck, onSize }) {
  return {
    name: `${name}-ts-as-text`,
    setup(b) {
      b.onLoad({ filter: stubRe }, async () => {
        const contents = rewrite ? await rewrite() : await source();
        if (legacyCheck) assertLegacySafe(contents, `dist/${path.basename(outFile)}`);
        onSize(Buffer.byteLength(contents, 'utf8'));
        writeFileSync(path.resolve(dir, outFile), contents);
        return { contents, loader: 'text' };
      });
    },
  };
}

// ui.js and the two CSS files it is served with are mangled together (they share one class map).
const UI_CSS = ['ui-base.css', 'ui-simple.css'].map((f) => path.resolve(dir, 'src/web/client', f));
const uiSource = clientSource('ui-entry.ts', 'esnext');
// e2e and the screenshot script select by class, so the opt-in mock form leaves those classes
// readable (found by scanning e2e/, no list to maintain); DECKBRIDGE_MANGLE_MOCK=all mangles them too.
function e2eSelectedClasses(css) {
  if (!isMockBuild || process.env.DECKBRIDGE_MANGLE_MOCK === 'all') return [];
  const sources = ['tests', 'helpers', 'scripts'].flatMap((sub) => {
    const root = path.resolve(dir, '../e2e', sub);
    return readdirSync(root, { recursive: true })
      .filter((f) => /\.(?:ts|mjs)$/.test(f))
      .map((f) => readFileSync(path.join(root, f), 'utf8'));
  });
  return selectedClasses(sources, new Set(cssClasses(css).keys()));
}
const mangleUi = once(async () => {
  const css = await Promise.all(UI_CSS.map(minifyCss));
  const mangled = mangleClasses(css, await uiSource(), e2eSelectedClasses(css.join('')));
  const { classes, mangled: renamed, kept, stray, selected, prefix } = mangled.stats;
  console.log(
    `class names → ${classes} classes, ${renamed} mangled, ${kept} kept (${stray} stray, ${prefix} dynamic, ${selected} selected by e2e)`,
  );
  if (process.argv.includes('--mangle-report'))
    for (const [name, why] of mangled.kept) console.log(`  kept ${name}: ${why}`);
  return mangled;
});

const uiJsAsText = clientBundleAsText({
  name: 'ui',
  stubRe: /web[/\\]client[/\\]ui\.js$/,
  source: uiSource,
  rewrite: mangleClassNames ? async () => (await mangleUi()).js : undefined,
  outFile: 'dist/ui.js',
  onSize: (n) => (uiJsSize = n),
});
const deckJsAsText = clientBundleAsText({
  name: 'deck',
  stubRe: /web[/\\]client[/\\]deck[/\\]deck\.js$/,
  source: clientSource('deck/deck-entry.ts', DECK_JS_TARGETS),
  outFile: 'dist/deck.js',
  legacyCheck: true,
  onSize: (n) => (deckJsSize = n),
});
const clientBundles = [uiJsAsText, deckJsAsText];

// Conservative HTML minifier: strips comments and collapses inter-tag/text
// whitespace, but never touches the contents of <script>, <style>, or <pre>
// blocks (those are extracted, placeholdered, and restored verbatim). This
// keeps inline scripts (with // line comments + template literals) and
// whitespace-significant <pre> content intact.
const PLACEHOLDER = (i) => ` HTMLPROTECT${i} `;
function minifyHtml(src) {
  const protectedBlocks = [];
  // Pull out script/style/pre (including their tags) so collapsing can't corrupt them.
  let html = src.replace(/<(script|style|pre)\b[^>]*>[\s\S]*?<\/\1>/gi, (m) => {
    const token = PLACEHOLDER(protectedBlocks.length);
    protectedBlocks.push(m);
    return token;
  });
  html = html
    // Drop comments, but preserve the <!doctype ...> declaration.
    .replace(/<!--[\s\S]*?-->/g, '')
    // Collapse whitespace between adjacent tags.
    .replace(/>\s+</g, '><')
    // Collapse any remaining whitespace runs (safe: pre/script/style are protected).
    .replace(/\s{2,}/g, ' ')
    .trim();
  // Restore protected blocks verbatim.
  // eslint-disable-next-line
  return html.replace(/ HTMLPROTECT(\d+) /g, (_, i) => protectedBlocks[Number(i)]);
}

// Minifies embedded text assets before they become QuickJS string constants:
//   .css via esbuild's CSS minifier (the ui CSS then goes through the class mangler),
//   .html via the conservative pass above.
// Result is handed back through the 'text' loader so consumers (assets.ts)
// still receive a plain string import.
async function minifyCss(file) {
  const { code } = await transform(await readFile(file, 'utf8'), {
    loader: 'css',
    minify: true,
    // The deck page's CSS must survive iOS 12 (no `inset` shorthand etc.).
    ...(/web[/\\]client[/\\]deck[/\\]/.test(file) ? { target: DECK_CSS_TARGETS } : {}),
    // Identify the file so esbuild reports CSS errors against the real path.
    sourcefile: file,
  });
  return code;
}
const minifyTextAssets = {
  name: 'minify-text-assets',
  setup(b) {
    b.onLoad({ filter: /\.css$/ }, async (args) => {
      const i = mangleClassNames ? UI_CSS.indexOf(path.resolve(args.path)) : -1;
      return {
        contents: i >= 0 ? (await mangleUi()).css[i] : await minifyCss(args.path),
        loader: 'text',
      };
    });
    b.onLoad({ filter: /\.html$/ }, async (args) => {
      const source = await readFile(args.path, 'utf8');
      return { contents: minifyHtml(source), loader: 'text' };
    });
  },
};

// Istanbul source instrumentation for coverage (engine-agnostic; runs on txiki/QuickJS).
// Only instruments src/**/*.ts (not test files, not node_modules, not .d.ts). TS→JS first so
// coverage metadata maps back to the original .ts via the input source map.
const istanbulPlugin = {
  name: 'istanbul',
  setup(b) {
    // Instrument the ORIGINAL TypeScript directly (istanbul-lib-instrument uses @babel/parser;
    // the 'typescript' parser plugin lets it read .ts). Coverage locations are then EXACT source
    // positions. The earlier approach (esbuild TS→JS, then instrument the JS and remap through
    // esbuild's source map) was only line-accurate, so HTML highlights drifted onto partial tokens.
    // esbuild strips the TS types from the instrumented output afterwards (loader: 'ts').
    const instrumenter = createInstrumenter({
      esModules: true,
      compact: false,
      produceSourceMap: false,
      coverageVariable: '__coverage__',
      // Replaces istanbul's default plugin list, so re-list the modern syntax in use + 'typescript'.
      // (No 'decorators'/'jsx' — unused here and they can conflict with the typescript plugin.)
      parserPlugins: [
        'typescript',
        'asyncGenerators',
        'bigInt',
        'classProperties',
        'classPrivateProperties',
        'classPrivateMethods',
        'dynamicImport',
        'exportDefaultFrom',
        'exportNamespaceFrom',
        'importMeta',
        'logicalAssignment',
        'nullishCoalescingOperator',
        'numericSeparator',
        'objectRestSpread',
        'optionalCatchBinding',
        'optionalChaining',
        'topLevelAwait',
      ],
    });
    b.onLoad({ filter: /\.ts$/ }, async (args) => {
      if (!args.path.includes(`${path.sep}src${path.sep}`)) return undefined;
      if (args.path.endsWith('.d.ts')) return undefined;
      const source = await readFile(args.path, 'utf8');
      const instrumented = instrumenter.instrumentSync(source, args.path);
      return { contents: instrumented, loader: 'ts' };
    });
  },
};

// `tjs.exit` is read-only and non-configurable, so it can be neither reassigned nor proxied
// over `tjs` itself (the get-trap invariant rejects it → "proxy: inconsistent get"). The banner
// instead shadows the global with a Proxy whose target is a *fresh empty object*, forwarding
// every member to the real tjs (methods bound) except `exit`, which only records the code. The
// footer flushes the coverage map and then calls the real exit, so the write lands first.
const COV_BANNER =
  'const __cov_realTjs = globalThis.tjs;' +
  'globalThis.__cov_exitCode = 0;' +
  'const tjs = new Proxy({}, {' +
  ' get(_t, p) {' +
  "  if (p === 'exit') return (c = 0) => { globalThis.__cov_exitCode = c | 0; };" +
  '  const v = __cov_realTjs[p];' +
  "  return typeof v === 'function' ? v.bind(__cov_realTjs) : v;" +
  ' },' +
  ' has(_t, p) { return p in __cov_realTjs; },' +
  '});';
const covFooter = (name) => {
  const covPath = JSON.stringify(`coverage/.tmp/${name}.json`);
  return (
    `(globalThis.__coverage__` +
    ` ? __cov_realTjs.writeFile(${covPath}, JSON.stringify(globalThis.__coverage__))` +
    `.catch((e) => console.error('coverage flush failed:', e && e.message))` +
    ` : Promise.resolve()).then(() => __cov_realTjs.exit(globalThis.__cov_exitCode | 0));`
  );
};

// Options shared by the main bundle and the USB worker bundle.
const shared = {
  bundle: true,
  platform: 'neutral',
  target: 'esnext',
  supported: { decorators: false },
  format: 'esm',
  minify: true,
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
    __LOG_LEVEL__: String(logLevel),
    __VERSION__: JSON.stringify(version),
    __DEMO__: 'false',
    __SIMPLE_ONLY__: JSON.stringify(isSimpleOnly),
    __MOCK_BUILD__: JSON.stringify(isMockBuild),
  },
  loader: {
    '.html': 'text',
    '.css': 'text',
  },
};

mkdirSync(path.resolve(dir, 'dist'), { recursive: true });
mkdirSync(path.dirname(outfile), { recursive: true });

// 1) Bundle the worker entries. Each is bundled standalone, written to dist for
// debugging, and embedded as text into the main program via a `virtual:` module
// below.
//   hid-worker       generic HID worker (handles Mirabox + Elgato gen1/gen2)
//   hid-scan-worker  dedicated operational HID discovery. Native enumeration can
//                    block for seconds on hostile Windows HID collections, so it
//                    never runs on the CORA thread.
//   plugin-worker    runs user-authored plugin JS in isolation
const WORKER_ENTRIES = {
  'hid-worker': 'worker/hid-worker.ts',
  'hid-scan-worker': 'worker/hid-scan-worker.ts',
  'plugin-worker': 'plugin/plugin-worker.ts',
};
const workerSources = {};
for (const [name, entry] of Object.entries(WORKER_ENTRIES)) {
  const result = await build({
    ...shared,
    entryPoints: [`${dir}/src/${entry}`],
    write: false,
    plugins: [...clientBundles, minifyTextAssets],
  });
  workerSources[name] = result.outputFiles[0].text;
  writeFileSync(path.resolve(dir, `dist/${name}.js`), workerSources[name]);
}

// Platform shared-library extension, and the name cargo actually emits for the
// native lib. Cargo drops the `lib` prefix on Windows (unlike the .dylib/.so
// builds). Both the embed path (resolveNativeLibFiles) and the bundle-sizes CSV
// need these, so they are derived once — a Windows-naming change must not have
// to be made in two places that agree only by luck.
const LIB_EXT = { darwin: 'dylib', win32: 'dll' }[process.platform] ?? 'so';
const NATIVE_LIB_ARTIFACT =
  process.platform === 'win32' ? 'deckbridge_native.dll' : `libdeckbridge_native.${LIB_EXT}`;

// ── virtual:native-libs ──────────────────────────────────────────────────────
// Emits a module exporting the native libraries as latin1 strings (one char per byte) so the
// runtime can extract them to a cache dir (ts/src/infra/native-libs.ts). `tjs compile` deflates
// the bytecode anyway, and raw bytes end up smaller there than base64 or gzip+base64 (and need no
// runtime decode). Same virtual-module shape as virtual:hid-worker below. Empty list when noEmbed
// (dev/test builds: env vars from mise point at the real files instead).
function resolveNativeLibFiles() {
  const isWin = process.platform === 'win32';
  const ext = LIB_EXT;
  const files = [];
  // Cargo emits `deckbridge_native.dll` on Windows (no `lib` prefix, unlike the
  // .dylib/.so builds). The embedded NAME stays `libdeckbridge_native.dll` — renamed
  // here, at embed time — so ENV_BY_PREFIX in native-libs.ts (which matches the
  // `libdeckbridge_native` prefix) keeps working unmodified for all platforms.
  const nativeLibArtifact = NATIVE_LIB_ARTIFACT;
  const required = [
    [
      'libdeckbridge_native',
      process.env.DECKBRIDGE_NATIVE_LIB ??
        path.resolve(dir, `../rust/target/release/${nativeLibArtifact}`),
    ],
  ];
  for (const [base, p] of required) {
    if (!existsSync(p)) {
      throw new Error(`native-libs embed: missing ${p} — run 'mise run deckbridge-native' first`);
    }
    files.push({ name: `${base}.${ext}`, path: p });
  }
  // libhidapi: optional on macOS/Linux at build time (runtime falls back to
  // brew/system paths) — but Windows ships NO system hidapi.dll, so skipping it
  // there would produce a binary with no HID backend at all. Hard-fail instead.
  let hidapiCandidates;
  if (process.env.HIDAPI_LIB) {
    hidapiCandidates = [process.env.HIDAPI_LIB];
  } else if (process.platform === 'darwin') {
    hidapiCandidates = [
      '/opt/homebrew/opt/hidapi/lib/libhidapi.dylib',
      '/usr/local/opt/hidapi/lib/libhidapi.dylib',
    ];
  } else if (isWin) {
    hidapiCandidates = [path.resolve(dir, '../rust/target/hidapi/hidapi.dll')];
  } else {
    hidapiCandidates = [
      '/usr/lib/x86_64-linux-gnu/libhidapi-hidraw.so.0',
      '/usr/lib/aarch64-linux-gnu/libhidapi-hidraw.so.0',
      '/usr/lib/libhidapi-hidraw.so.0',
    ];
  }
  const hidapi = hidapiCandidates.find((p) => existsSync(p));
  if (hidapi) {
    files.push({ name: `libhidapi.${ext}`, path: hidapi });
  } else if (isWin) {
    throw new Error(
      `native-libs embed: hidapi.dll not found (tried: ${hidapiCandidates.join(', ')}) — ` +
        `build it and set HIDAPI_LIB before embedding (Windows has no system hidapi).`,
    );
  } else {
    console.warn(
      'native-libs embed: libhidapi not found, skipping (runtime will use system fallbacks)',
    );
  }
  return files;
}

function buildNativeLibsModuleSource() {
  if (noEmbed) {
    return "export const NATIVE_LIBS = [];\nexport const NATIVE_LIBS_HASH = '';\n";
  }
  const files = resolveNativeLibFiles();
  const hash = createHash('sha256');
  const entries = files.map(({ name, path: p }) => {
    const raw = readFileSync(realpathSync(p)); // realpath: brew libhidapi.dylib is a symlink
    hash.update(raw);
    return { name, rawSize: raw.length, data: raw.toString('latin1') };
  });
  const h = hash.digest('hex').slice(0, 16);
  const lines = entries.map(
    (e) =>
      `  { name: ${JSON.stringify(e.name)}, rawSize: ${e.rawSize}, data: ${JSON.stringify(e.data)} },`,
  );
  const summary = entries.map((e) => `${e.name} ${(e.rawSize / 1024).toFixed(0)}K`).join(', ');
  console.log(`embed native libs (hash ${h}): ${summary}`);
  return `export const NATIVE_LIBS_HASH = ${JSON.stringify(h)};\nexport const NATIVE_LIBS = [\n${lines.join('\n')}\n];\n`;
}

const nativeLibsModuleSource = buildNativeLibsModuleSource();

// Resolves `import src from '<spec>'` to in-memory contents. All four virtual
// modules share this shape: the three worker bundles (as text) and the
// native-libs source (as js). `getContents` stays a thunk so the contents are
// read at load time, not at plugin-construction time.
const virtualModule = (spec, namespace, getContents, loader = 'text') => ({
  name: spec.replace(/[^a-z0-9]+/gi, '-'),
  setup(b) {
    b.onResolve({ filter: new RegExp(`^${spec}$`) }, () => ({ path: spec, namespace }));
    b.onLoad({ filter: /.*/, namespace }, () => ({ contents: getContents(), loader }));
  },
});

const virtualNativeLibs = virtualModule(
  'virtual:native-libs',
  'nativelibs',
  () => nativeLibsModuleSource,
  'js',
);
const virtualWorker = virtualModule(
  'virtual:hid-worker',
  'hidworker',
  () => workerSources['hid-worker'],
);
const virtualScanWorker = virtualModule(
  'virtual:hid-scan-worker',
  'hidscanworker',
  () => workerSources['hid-scan-worker'],
);
const virtualPluginWorker = virtualModule(
  'virtual:plugin-worker',
  'pluginworker',
  () => workerSources['plugin-worker'],
);

// A release build must never load the mock driver source, even during bundling.
// Its import is unreachable after constant folding; a stub also protects the
// package if that optimization changes.
const excludeMockDriver = {
  name: 'exclude-mock-driver',
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

// 2) Bundle the main program, embedding the worker via the virtual module.
const isCoverageTest = isTest && isCoverage;
const mainResult = await build({
  ...shared,
  metafile: true,
  // Raw UTF-8 instead of \xNN escapes: the embedded latin1 strings (native libs, font atlas) would
  // otherwise grow bundle.js by ~0.5 MB. The bytecode `tjs compile` writes is the same either way.
  charset: 'utf8',
  ...(isCoverageTest ? { minifySyntax: false } : {}),
  entryPoints: [entryPoint],
  outfile,
  plugins: [
    ...(isCoverageTest ? [istanbulPlugin] : []),
    ...clientBundles,
    virtualWorker,
    virtualScanWorker,
    virtualPluginWorker,
    virtualNativeLibs,
    ...(!isMockBuild ? [excludeMockDriver] : []),
    minifyTextAssets,
  ],
  ...(isCoverageTest ? { banner: { js: COV_BANNER }, footer: { js: covFooter(testName) } } : {}),
});

if (!isMockBuild && !isTest && !isSmoke && !isProbe) {
  const mockInputs = Object.keys(mainResult.metafile.inputs).filter((input) =>
    /[/\\](?:devices[/\\]mock|web[/\\]server[/\\]mock-(?:config|input))\.ts$/.test(input),
  );
  if (mockInputs.length) throw new Error(`release bundle includes mock modules: ${mockInputs}`);
  const mockRoutes = [
    '/api/mock-config',
    '/api/mock/extra-key/',
    '/api/mock/dial',
    '/api/mock/touch',
  ];
  for (const artifact of [
    outfile,
    path.resolve(dir, 'dist/ui.js'),
    ...Object.keys(WORKER_ENTRIES).map((name) => path.resolve(dir, `dist/${name}.js`)),
  ]) {
    const contents = readFileSync(artifact, 'utf8');
    const leakedRoute = mockRoutes.find((route) => contents.includes(route));
    if (leakedRoute)
      throw new Error(`release bundle contains mock route ${leakedRoute}: ${artifact}`);
  }
}

const workerPath = path.resolve(dir, 'dist/hid-worker.js');
console.log(`bundle → dist/hid-worker.js (${(statSync(workerPath).size / 1024).toFixed(1)} kB)`);
const scanWorkerPath = path.resolve(dir, 'dist/hid-scan-worker.js');
console.log(
  `bundle → dist/hid-scan-worker.js (${(statSync(scanWorkerPath).size / 1024).toFixed(1)} kB)`,
);
console.log(`bundle → ${outfile} (${(statSync(outfile).size / 1024).toFixed(1)} kB)`);
console.log(
  `bundle → dist/ui.js webui (${(uiJsSize / 1024).toFixed(1)} kB)${isSimpleOnly ? ' [simple-only]' : ' [advanced]'}`,
);
if (deckJsSize > 0) console.log(`bundle → dist/deck.js (${(deckJsSize / 1024).toFixed(1)} kB)`);

if (!isTest && !isSmoke && !isMockBuild) {
  const CSV = path.resolve(dir, '../bundle-sizes.csv');
  const now = new Date().toISOString();
  const isWinCsv = process.platform === 'win32';
  const artifacts = [
    ['hid-worker', path.resolve(dir, 'dist/hid-worker.js')],
    ['hid-scan-worker', path.resolve(dir, 'dist/hid-scan-worker.js')],
    ['bundle', outfile],
    ['webui', path.resolve(dir, 'dist/ui.js')],
    ['deckbridge-native', path.resolve(dir, `../rust/target/release/${NATIVE_LIB_ARTIFACT}`)],
    [
      'deckbridge-tray',
      path.resolve(dir, `../rust/target/release/deckbridge-tray${isWinCsv ? '.exe' : ''}`),
    ],
  ];
  const cols = artifacts.map(([name]) => name);
  // The `zip` field is filled in later by scripts/package.sh — the release zip
  // doesn't exist yet at bundle time (package runs three steps after this).
  // Non-package builds leave it empty (the trailing comma below).
  if (!existsSync(CSV)) appendFileSync(CSV, `timestamp and size (kB), ${cols.join(', ')},zip\n`);
  const sizes = artifacts.map(([, p]) =>
    existsSync(p) ? (statSync(p).size / 1024).toFixed(3) : '',
  );
  appendFileSync(CSV, `${now}, ${sizes.join(', ')},\n`);
}
