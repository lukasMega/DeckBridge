import assert from 'tjs:assert';
import type { EmbeddedAsset } from 'virtual:web-assets';
import { staticAsset } from '../src/web/server/static-asset.js';
import { testAsync as test, summaryExit } from './helpers/harness.js';

const TEXT = '<!doctype html><title>ünï</title>'.repeat(40);

const gzipOf = async (text: string): Promise<Uint8Array> =>
  new Uint8Array(
    await new Response(
      new Blob([text]).stream().pipeThrough(new CompressionStream('gzip')),
    ).arrayBuffer(),
  );

const GZ = await gzipOf(TEXT);
const ASSET: EmbeddedAsset = { data: String.fromCharCode(...GZ), etag: 'abc123' };

const request = (headers: Record<string, string> = {}): Request =>
  new Request('http://127.0.0.1/ui.js', { headers });
const serve = async (headers?: Record<string, string>, opts?: Parameters<typeof staticAsset>[3]) =>
  staticAsset(request(headers), ASSET, 'text/html; charset=utf-8', opts);

console.log('\nstatic asset handler');

await test('gzip client: stored bytes, Content-Encoding, ETag, no-cache, Vary', async () => {
  const res = await serve({ 'Accept-Encoding': 'br, gzip;q=0.8' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Encoding'), 'gzip');
  assert.equal(res.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.equal(res.headers.get('Cache-Control'), 'no-cache');
  assert.equal(res.headers.get('ETag'), '"abc123"');
  assert.equal(res.headers.get('Vary'), 'Accept-Encoding');
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [...GZ]);
});

await test('If-None-Match: exact, weak, listed and * answer 304 with no body', async () => {
  for (const inm of ['"abc123"', 'W/"abc123"', '"zzz", "abc123"', '*']) {
    const res = await serve({ 'Accept-Encoding': 'gzip', 'If-None-Match': inm });
    assert.equal(res.status, 304, inm);
    assert.equal(res.headers.get('ETag'), '"abc123"');
    assert.equal(res.headers.get('Cache-Control'), 'no-cache');
    assert.equal(res.headers.get('Content-Encoding'), null);
    assert.equal((await res.arrayBuffer()).byteLength, 0);
  }
  const stale = await serve({ 'Accept-Encoding': 'gzip', 'If-None-Match': '"old"' });
  assert.equal(stale.status, 200);
});

await test('no gzip in Accept-Encoding: inflated text, own ETag, own 304', async () => {
  const identity: Record<string, string>[] = [
    {},
    { 'Accept-Encoding': 'identity' },
    { 'Accept-Encoding': 'gzip;q=0' },
  ];
  for (const headers of identity) {
    const res = await serve(headers);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Encoding'), null);
    assert.equal(res.headers.get('ETag'), '"abc123-id"');
    assert.equal(await res.text(), TEXT);
  }
  // The gzip tag does not validate the identity representation, and vice versa.
  const crossed = await serve({ 'If-None-Match': '"abc123"' });
  assert.equal(crossed.status, 200);
  const same = await serve({ 'If-None-Match': '"abc123-id"' });
  assert.equal(same.status, 304);
});

await test('wildcard Accept-Encoding counts as gzip', async () => {
  const res = await serve({ 'Accept-Encoding': '*' });
  assert.equal(res.headers.get('Content-Encoding'), 'gzip');
});

await test('cacheControl and extra headers apply to 200 and 304', async () => {
  const opts = { cacheControl: 'no-store', headers: { 'X-Frame-Options': 'DENY' } };
  const ok = await serve({ 'Accept-Encoding': 'gzip' }, opts);
  assert.equal(ok.headers.get('Cache-Control'), 'no-store');
  assert.equal(ok.headers.get('X-Frame-Options'), 'DENY');
  const notModified = await serve({ 'Accept-Encoding': 'gzip', 'If-None-Match': '"abc123"' }, opts);
  assert.equal(notModified.status, 304);
  assert.equal(notModified.headers.get('X-Frame-Options'), 'DENY');
});

summaryExit();
