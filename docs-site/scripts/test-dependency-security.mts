import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

// Resolve the actual transitive copies used by Docusaurus, not test-only dependencies.
function requireFrom(packages: string[]) {
  let require = createRequire(
    createRequire(import.meta.url).resolve(`${packages[0]}/package.json`),
  );
  for (const name of packages.slice(1)) require = createRequire(require.resolve(name));
  return require;
}

const braces = requireFrom(['@docusaurus/core', 'chokidar'])('braces');
const micromatch = requireFrom(['@docusaurus/core', '@docusaurus/utils'])('micromatch');
const CachePolicy = requireFrom([
  '@docusaurus/core',
  'update-notifier',
  'latest-version',
  'package-json',
  'got',
  'cacheable-request',
])('http-cache-semantics');
const uri = requireFrom(['@docusaurus/core', 'webpack', 'schema-utils', 'ajv'])('fast-uri');
const tinypoolPath = requireFrom(['@docusaurus/core']).resolve('tinypool');
const sourceMap = requireFrom(['@docusaurus/core', '@docusaurus/bundler', 'postcss'])(
  'source-map-js',
);
const selectorPaths = [
  [
    '@docusaurus/core',
    '@docusaurus/bundler',
    'cssnano',
    'cssnano-preset-default',
    'postcss-minify-selectors',
  ],
  ['@docusaurus/core', '@docusaurus/bundler', 'postcss-preset-env', 'postcss-nesting'],
].map((packages) => requireFrom(packages).resolve('postcss-selector-parser'));

const katexPaths = [
  ['@docusaurus/theme-mermaid', 'mermaid'],
  ['@mermaid-js/mermaid-cli', 'mermaid'],
  ['@mermaid-js/mermaid-cli'],
].map((packages) => {
  let require = createRequire(createRequire(import.meta.url).resolve(packages[0]));
  for (const name of packages.slice(1)) require = createRequire(require.resolve(name));
  return require.resolve('katex');
});

test('KaTeX ignores inherited trust options (CVE-2026-103923)', () => {
  for (const modulePath of new Set(katexPaths)) {
    // Mermaid imports ESM; also check the CommonJS entry point in isolation.
    for (const entry of [modulePath, join(dirname(modulePath), 'katex.mjs')]) {
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          String.raw`
      import assert from 'node:assert/strict';
      import { pathToFileURL } from 'node:url';
      const { default: katex } = await import(pathToFileURL(process.argv[1]).href);
      const expression = '\\href{https://attacker.test/}{click}';
      const render = (options) => katex.renderToString(expression, options);
      const baseline = render({});
      assert.equal(baseline.includes('href='), false);
      assert.equal(render(Object.create({ trust: true })), baseline);
      Object.defineProperty(Object.prototype, 'trust', {
        value: true, writable: true, configurable: true,
      });
      try {
        assert.equal(render({}), baseline);
        assert.equal(render(), baseline);
        assert.ok(katex.renderToString('x^2').includes('katex'));
      } finally {
        delete Object.prototype.trust;
      }
      assert.ok(render({ trust: true }).includes('href="https://attacker.test/"'));
    `,
          entry,
        ],
        { timeout: 10_000, stdio: 'pipe' },
      );
    }
  }
});

test('selector parsing handles large flat selectors (CVE-2026-104844)', () => {
  for (const modulePath of new Set(selectorPaths)) {
    // Bound a regressed parser's CPU usage without blocking the test runner.
    execFileSync(
      process.execPath,
      [
        '-e',
        `
      const assert = require('node:assert/strict');
      const parser = require(process.argv[1]);
      for (const token of ['.a', '#a']) {
        const selector = token.repeat(200_000);
        const ast = parser().astSync(selector);
        assert.equal(ast.first.nodes.length, 200_000);
        assert.equal(ast.toString(), selector);
      }
      const ordinary = 'a[href="x"] > .item:not(.hidden), #main';
      assert.equal(parser().processSync(ordinary), ordinary);
    `,
        modulePath,
      ],
      { timeout: 10_000, stdio: 'pipe' },
    );
  }
});

test('indexed source maps reject unsafe offsets (CVE-2026-93749)', () => {
  const map = {
    version: 3,
    sources: ['input.js'],
    sourcesContent: ['x'],
    names: [],
    mappings: 'AAAA',
  };
  const indexed = (line: unknown, column: unknown, child: object = map) => ({
    version: 3,
    sections: [{ offset: { line, column }, map: child }],
  });
  for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
    assert.throws(
      () => new sourceMap.SourceMapConsumer(indexed(value, 0)),
      /non-negative integers/,
    );
    assert.throws(
      () => new sourceMap.SourceMapConsumer(indexed(0, value)),
      /non-negative integers/,
    );
  }
  assert.throws(() => new sourceMap.SourceMapConsumer(indexed(10_000_001, 0)), /must not exceed/);
  assert.throws(
    () => new sourceMap.SourceMapConsumer(indexed(6_000_000, 0, indexed(6_000_000, 0))),
    /including offsets of nested sections/,
  );
  const consumer = new sourceMap.SourceMapConsumer(indexed(2, 0));
  assert.deepEqual(consumer.originalPositionFor({ line: 3, column: 1 }), {
    source: 'input.js',
    line: 1,
    column: 0,
    name: null,
  });
  const node = sourceMap.SourceNode.fromStringWithSourceMap(
    'var x;\n',
    new sourceMap.SourceMapConsumer(indexed(10_000_000, 0)),
  );
  assert.equal(node.toString(), 'var x;\n');
  assert.ok(node.children.length < 10, 'offset past source must not allocate empty lines');
});

test('tinypool ignores inherited worker and run options (CVE-2026-104848/104849)', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'deckbridge-tinypool-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const worker = join(directory, 'worker.mjs');
  const payload = join(directory, 'payload.cjs');
  const marker = join(directory, 'injected.txt');
  const redirectedWorker = join(directory, 'redirected-worker.mjs');
  const runner = join(directory, 'runner.mjs');
  writeFileSync(worker, 'export default (n) => n * 2;');
  writeFileSync(
    payload,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'injected');`,
  );
  writeFileSync(redirectedWorker, 'export default () => -1;');
  // Each pollution vector runs in its own process to protect the test runner.
  writeFileSync(
    runner,
    `
    import assert from 'node:assert/strict';
    import { existsSync } from 'node:fs';
    import { pathToFileURL } from 'node:url';
    const [modulePath, key, worker, payload, marker, redirectedWorker] = process.argv.slice(2);
    const { default: Tinypool } = await import(pathToFileURL(modulePath).href);
    const values = {
      execArgv: ['--require', payload],
      env: { ...process.env, NODE_OPTIONS: '--require ' + payload },
      filename: redirectedWorker,
    };
    Object.defineProperty(Object.prototype, key, {
      value: values[key], writable: true, configurable: true, enumerable: true,
    });
    const pool = new Tinypool({ filename: worker, minThreads: 1, maxThreads: 1, isolateWorkers: false });
    try {
      assert.equal(await pool.run(21, {}), 42, key + ' redirected worker');
      assert.equal(existsSync(marker), false, key + ' executed injected preload');
      assert.equal(await pool.run(21, { filename: redirectedWorker }), -1);
    } finally {
      delete Object.prototype[key];
      await pool.destroy();
    }
  `,
  );
  for (const key of ['execArgv', 'env', 'filename']) {
    await t.test(key, () => {
      rmSync(marker, { force: true });
      execFileSync(
        process.execPath,
        [runner, tinypoolPath, key, worker, payload, marker, redirectedWorker],
        { timeout: 10_000, stdio: 'pipe' },
      );
    });
  }
});

test('fast-uri consistently normalizes encoded host case (CVE-2026-86472)', () => {
  for (const [input, canonical] of [
    ['//%41.com', '//a.com'],
    ['//%4a.ExAmPlE/Path?Q=1#Frag', '//j.example/Path?Q=1#Frag'],
    ['//%5a.test:8080/path', '//z.test:8080/path'],
    ['https://%41.com/Path', 'https://a.com/Path'],
  ]) {
    assert.equal(uri.parse(input).host, uri.parse(canonical).host);
    assert.equal(uri.normalize(input), uri.normalize(canonical));
    assert.equal(uri.equal(input, canonical), true);
    assert.equal(uri.equal(canonical, input), true);
  }
  assert.equal(uri.equal('//A.com', '//a.com'), true);
  assert.equal(uri.equal('//a.com/Path', '//a.com/path'), false);
});

test('braces rejects deep patterns before recursive walkers run (CVE-2026-93687)', () => {
  const patterns = [
    '{'.repeat(4000) + 'x,y' + '}'.repeat(4000),
    '('.repeat(4000) + 'x' + ')'.repeat(4000),
    '{('.repeat(60) + 'x,y' + ')}'.repeat(60),
    '{'.repeat(101) + 'x,y',
  ];
  for (const method of [braces, braces.parse, braces.compile, braces.expand, braces.stringify]) {
    for (const pattern of patterns) {
      assert.throws(() => method(pattern), {
        name: 'SyntaxError',
        message: 'Pattern nesting depth exceeds max of 100',
      });
    }
  }
  assert.throws(() => micromatch.braceExpand(patterns[0]), { name: 'SyntaxError' });
});

test('braces preserves ordinary patterns and literal braces', () => {
  assert.deepEqual(braces('a/{x,y}/b'), ['a/(x|y)/b']);
  assert.deepEqual(braces.expand('a/{x,{1..3},y}/b'), [
    'a/x/b',
    'a/1/b',
    'a/2/b',
    'a/3/b',
    'a/y/b',
  ]);
  assert.doesNotThrow(() => braces.compile('{'.repeat(100) + 'x,y' + '}'.repeat(100)));
  assert.throws(() => braces.parse('{'.repeat(101) + 'x,y' + '}'.repeat(101)), SyntaxError);
  assert.doesNotThrow(() => braces.compile('{x,y}'.repeat(200)));
  assert.doesNotThrow(() => braces.parse(String.raw`\{`.repeat(1000)));
  assert.doesNotThrow(() => braces.parse('"' + '{'.repeat(1000) + '"'));
  assert.doesNotThrow(() => braces.parse('[' + '{'.repeat(1000) + ']'));
  assert.deepEqual(micromatch(['a.js', 'b.ts', 'c.txt'], '*.{js,ts}'), ['a.js', 'b.ts']);
});

const request = { url: 'https://example.test/account', headers: { host: 'example.test' } };

function cachePolicy(headers: Record<string, string>, requestHeaders = {}, shared = true) {
  const policy = new CachePolicy(
    { ...request, headers: { ...request.headers, ...requestHeaders } },
    { status: 200, headers },
    { shared },
  );
  const receivedAt = policy.toObject().t;
  policy.now = () => receivedAt + 1000;
  return policy;
}

test('max-stale cannot reuse security-zeroed responses (CVE-2026-93748)', () => {
  const responses: Record<string, string>[] = [
    { 'set-cookie': 'session=other-user', 'cache-control': 'max-age=60' },
    { 'cache-control': 'no-cache, max-age=60' },
    { 'cache-control': 'private, max-age=60' },
    { 'cache-control': 'no-store, max-age=60' },
    { 'cache-control': 'proxy-revalidate, max-age=60' },
    { 'cache-control': 'max-age=60', vary: '*' },
  ];
  const policies = responses.map((headers) => cachePolicy(headers));
  policies.push(
    cachePolicy({ 'cache-control': 'max-age=60' }, { authorization: 'Bearer other-user' }),
  );
  policies.push(cachePolicy({ 'cache-control': 'max-age=60' }, { 'cache-control': 'no-store' }));
  for (const policy of policies) {
    assert.equal(policy.maxAge(), 0);
    for (const directive of ['max-stale', 'max-stale=999999']) {
      const incoming = { ...request, headers: { ...request.headers, 'cache-control': directive } };
      assert.equal(policy.satisfiesWithoutRevalidation(incoming), false);
      const result = policy.evaluateRequest(incoming);
      assert.equal(result.response, undefined);
      assert.equal(result.revalidation.synchronous, true);
    }
    const restored = CachePolicy.fromObject(policy.toObject());
    restored.now = policy.now;
    assert.equal(
      restored.satisfiesWithoutRevalidation({
        ...request,
        headers: { ...request.headers, 'cache-control': 'max-stale' },
      }),
      false,
    );
  }
});

test('other stale directives cannot revive security-zeroed responses', () => {
  const policy = cachePolicy({
    'set-cookie': 'session=other-user',
    'cache-control': 'max-age=60, stale-while-revalidate=300, stale-if-error=300',
  });
  assert.equal(policy.timeToLive(), 0);
  assert.equal(policy.useStaleWhileRevalidate(), false);
  assert.equal(policy.evaluateRequest(request).response, undefined);
  assert.equal(policy.revalidatedPolicy(request, { status: 500, headers: {} }).modified, true);
});

test('safe expired responses still support max-stale and ordinary caching', () => {
  const responses: Record<string, string>[] = [
    { 'cache-control': 'public, max-age=0' },
    { 'cache-control': 'public, max-age=0', 'set-cookie': 'explicitly-public' },
  ];
  for (const headers of responses) {
    const policy = cachePolicy(headers);
    assert.equal(
      policy.satisfiesWithoutRevalidation({
        ...request,
        headers: { ...request.headers, 'cache-control': 'max-stale=60' },
      }),
      true,
    );
    assert.equal(policy.satisfiesWithoutRevalidation(request), false);
  }
  const fresh = cachePolicy({ 'cache-control': 'public, max-age=60' });
  assert.equal(fresh.satisfiesWithoutRevalidation(request), true);
  const personal = cachePolicy(
    { 'cache-control': 'private, max-age=60', 'set-cookie': 'own-session' },
    {},
    false,
  );
  assert.equal(personal.satisfiesWithoutRevalidation(request), true);
});
