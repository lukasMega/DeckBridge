import assert from 'tjs:assert';
import {
  extractLibs,
  cleanupOldHashDirs,
  envVarFor,
  defaultCacheRoot,
} from '../src/infra/native-libs.js';
import type { EmbeddedNativeLib } from 'virtual:native-libs';
import { testAsync as test, summary } from './helpers/harness.js';

function bytesToLatin1(data: Uint8Array): string {
  let s = '';
  for (const b of data) s += String.fromCharCode(b);
  return s;
}

function makeFixtureLib(name: string, content: string | Uint8Array): EmbeddedNativeLib {
  const raw = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return { name, rawSize: raw.length, data: bytesToLatin1(raw) };
}

const ROOT = `${tjs.tmpDir}/native-libs-test-${tjs.pid}`;

// envVarFor

console.log('\nenvVarFor');

await test('maps lib names to env vars', () => {
  assert.equal(envVarFor('libdeckbridge_native.dylib'), 'DECKBRIDGE_NATIVE_LIB');
  assert.equal(envVarFor('libhidapi.dylib'), 'HIDAPI_LIB');
  assert.equal(envVarFor('libunknown.dylib'), undefined);
});

await test('maps lib names to env vars (Windows .dll names)', () => {
  // Same prefix match, just a different extension — the embedded name keeps the
  // `libdeckbridge_native`/`libhidapi` prefix on every platform (ts/build.mjs
  // renames the prefix-less Windows cargo artifact at embed time).
  assert.equal(envVarFor('libdeckbridge_native.dll'), 'DECKBRIDGE_NATIVE_LIB');
  assert.equal(envVarFor('libhidapi.dll'), 'HIDAPI_LIB');
});

// defaultCacheRoot

console.log('\ndefaultCacheRoot');

// DECKBRIDGE_CACHE_DIR short-circuits every branch — clear it around these tests
// so the platform branch under test actually runs, then restore whatever was there.
async function withoutCacheDirOverride(fn: () => void | Promise<void>): Promise<void> {
  const prev = tjs.env.DECKBRIDGE_CACHE_DIR;
  delete tjs.env.DECKBRIDGE_CACHE_DIR;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete tjs.env.DECKBRIDGE_CACHE_DIR;
    else tjs.env.DECKBRIDGE_CACHE_DIR = prev;
  }
}

await test('macOS branch is unchanged (Library/Caches)', async () => {
  await withoutCacheDirOverride(() => {
    assert.equal(defaultCacheRoot('macOS'), `${tjs.homeDir}/Library/Caches/deckbridge`);
  });
});

await test('Linux branch is unchanged (XDG_CACHE_HOME or ~/.cache)', async () => {
  await withoutCacheDirOverride(() => {
    const xdg = tjs.env.XDG_CACHE_HOME ?? `${tjs.homeDir}/.cache`;
    assert.equal(defaultCacheRoot('Linux'), `${xdg}/deckbridge`);
  });
});

await test('Windows branch uses LOCALAPPDATA when set', async () => {
  const prevLocalAppData = tjs.env.LOCALAPPDATA;
  tjs.env.LOCALAPPDATA = 'C:/Users/x/AppData/Local';
  try {
    await withoutCacheDirOverride(() => {
      assert.equal(defaultCacheRoot('Windows'), 'C:/Users/x/AppData/Local/deckbridge');
    });
  } finally {
    if (prevLocalAppData === undefined) delete tjs.env.LOCALAPPDATA;
    else tjs.env.LOCALAPPDATA = prevLocalAppData;
  }
});

await test('Windows branch falls back to home/AppData/Local when LOCALAPPDATA unset', async () => {
  const prevLocalAppData = tjs.env.LOCALAPPDATA;
  delete tjs.env.LOCALAPPDATA;
  try {
    await withoutCacheDirOverride(() => {
      assert.equal(defaultCacheRoot('Windows'), `${tjs.homeDir}/AppData/Local/deckbridge`);
    });
  } finally {
    if (prevLocalAppData !== undefined) tjs.env.LOCALAPPDATA = prevLocalAppData;
  }
});

// extractLibs

console.log('\nextractLibs');

await test('extracts to native-<hash>/ with correct content', async () => {
  const lib = makeFixtureLib('libdeckbridge_native.dylib', 'payload-A');
  const paths = await extractLibs([lib], 'hash0001', ROOT);
  assert.equal(
    paths['libdeckbridge_native.dylib'],
    `${ROOT}/native-hash0001/libdeckbridge_native.dylib`,
  );
  const data = await tjs.readFile(paths['libdeckbridge_native.dylib']!);
  assert.equal(new TextDecoder().decode(data), 'payload-A');
});

await test('extracted file is executable (mode 0o755)', async () => {
  const st = await tjs.stat(`${ROOT}/native-hash0001/libdeckbridge_native.dylib`);
  assert.equal(st.mode & 0o777, 0o755);
});

await test('every byte value survives the latin1 round trip (NUL, C0, C1, 0xFF)', async () => {
  const all = Uint8Array.from({ length: 512 }, (_, i) => i & 0xff);
  const lib = makeFixtureLib('libhidapi.dylib', all);
  assert.equal(lib.data.length, lib.rawSize, 'one char per byte');
  const paths = await extractLibs([lib], 'hash0001', ROOT);
  const data = await tjs.readFile(paths['libhidapi.dylib']!);
  assert.equal(data.length, 512);
  assert.ok(
    data.every((b, i) => b === i % 256),
    'bytes identical',
  );
});

await test('idempotent: second call keeps the existing file (size check, no rewrite)', async () => {
  const lib = makeFixtureLib('libdeckbridge_native.dylib', 'payload-A');
  // Overwrite the extracted file with same-size different content, then re-extract:
  // the size check must consider it valid and NOT rewrite it.
  const target = `${ROOT}/native-hash0001/libdeckbridge_native.dylib`;
  await tjs.writeFile(target, 'payload-B');
  await extractLibs([lib], 'hash0001', ROOT);
  const data = await tjs.readFile(target);
  assert.equal(new TextDecoder().decode(data), 'payload-B');
});

await test('wrong-size file is re-extracted', async () => {
  const lib = makeFixtureLib('libdeckbridge_native.dylib', 'payload-A');
  const target = `${ROOT}/native-hash0001/libdeckbridge_native.dylib`;
  await tjs.writeFile(target, 'short');
  await extractLibs([lib], 'hash0001', ROOT);
  const data = await tjs.readFile(target);
  assert.equal(new TextDecoder().decode(data), 'payload-A');
});

await test('truncated embed throws and writes nothing', async () => {
  const lib = { ...makeFixtureLib('libtruncated.dylib', 'payload-A'), rawSize: 10 };
  let error: Error | undefined;
  try {
    await extractLibs([lib], 'hash0001', ROOT);
  } catch (e) {
    error = e as Error;
  }
  assert.ok(error?.message.includes('expected 10'), `unexpected: ${error?.message}`);
  let exists = true;
  try {
    await tjs.stat(`${ROOT}/native-hash0001/libtruncated.dylib`);
  } catch {
    exists = false;
  }
  assert.ok(!exists, 'no file written');
});

// cleanupOldHashDirs

console.log('\ncleanupOldHashDirs');

await test('removes other native-* dirs, keeps current', async () => {
  const lib = makeFixtureLib('libdeckbridge_native.dylib', 'x');
  await extractLibs([lib], 'hash0002', ROOT);
  await cleanupOldHashDirs(ROOT, 'hash0002');
  let oldExists = true;
  try {
    await tjs.stat(`${ROOT}/native-hash0001`);
  } catch {
    oldExists = false;
  }
  assert.ok(!oldExists, 'old hash dir should be gone');
  const st = await tjs.stat(`${ROOT}/native-hash0002/libdeckbridge_native.dylib`);
  assert.ok(st.isFile, 'current hash dir must survive');
});

// Cleanup + summary

try {
  await tjs.remove(ROOT, { recursive: true });
} catch {}

summary();
