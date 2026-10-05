import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
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
