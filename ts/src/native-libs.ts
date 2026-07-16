// Extracts the native libraries embedded in the bundle (virtual:native-libs,
// gzip + base64) into a content-addressed cache directory, then points the
// DECKBRIDGE_NATIVE_LIB / HIDAPI_LIB env vars at the extracted files.
// Rules:
//   - An env var that is already set wins; that lib is skipped entirely
//     (dev workflow via mise [env], power-user override).
//   - Cache dir is named native-<build hash>, so a binary upgrade can never
//     reuse stale libs; warm starts only do a size check, no decode work.
//   - Concurrency-safe: write to <name>.tmp-<pid>, then atomic rename.
//   - If the cache root is unwritable, falls back to tjs.tmpDir; if that fails
//     too, logs and returns — the FFI loaders produce actionable errors anyway.
import { NATIVE_LIBS, NATIVE_LIBS_HASH } from 'virtual:native-libs';
import type { EmbeddedNativeLib } from 'virtual:native-libs';
import { log } from './logger.js';

import { platformName } from './os-utils.ts';

const ENV_BY_PREFIX: Array<[string, string]> = [
  ['libdeckbridge_native', 'DECKBRIDGE_NATIVE_LIB'],
  ['libhidapi', 'HIDAPI_LIB'],
];

export function envVarFor(name: string): string | undefined {
  return ENV_BY_PREFIX.find(([prefix]) => name.startsWith(prefix))?.[1];
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  const writeDone = writer.write(data as BufferSource).then(() => writer.close());
  const chunks: Uint8Array[] = [];
  const reader = ds.readable.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  await writeDone;
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export function defaultCacheRoot(): string {
  const home = tjs.homeDir;
  if (platformName() === 'macOS') return `${home}/Library/Caches/deckbridge`;
  const xdg = tjs.env.XDG_CACHE_HOME ?? `${home}/.cache`;
  return `${xdg}/deckbridge`;
}

async function fileHasSize(path: string, size: number): Promise<boolean> {
  try {
    const st = await tjs.stat(path);
    return st.isFile && st.size === size;
  } catch {
    return false;
  }
}

// Extracts the given libs into <cacheRoot>/native-<hash>/ and returns a map of
// lib name → extracted absolute path. Exported separately so tests can drive it
// with fixture data and a temp cache root.
export async function extractLibs(
  libs: EmbeddedNativeLib[],
  hash: string,
  cacheRoot: string,
): Promise<Record<string, string>> {
  const dir = `${cacheRoot}/native-${hash}`;
  await tjs.makeDir(dir, { recursive: true });
  const paths: Record<string, string> = {};
  for (const lib of libs) {
    const target = `${dir}/${lib.name}`;
    if (!(await fileHasSize(target, lib.rawSize))) {
      const raw = await gunzip(b64ToBytes(lib.gzB64));
      const tmp = `${target}.tmp-${tjs.pid}`;
      await tjs.writeFile(tmp, raw, { mode: 0o755 });
      try {
        await tjs.rename(tmp, target);
      } catch {
        // Another instance won the race; its file is identical. Drop ours.
        try {
          await tjs.remove(tmp);
        } catch {}
      }
    }
    paths[lib.name] = target;
  }
  return paths;
}

// Best-effort removal of native-<otherhash> dirs from previous versions.
export async function cleanupOldHashDirs(cacheRoot: string, keepHash: string): Promise<void> {
  try {
    const dirIter = await tjs.readDir(cacheRoot);
    for await (const item of dirIter) {
      if (
        item.isDirectory &&
        item.name.startsWith('native-') &&
        item.name !== `native-${keepHash}`
      ) {
        try {
          await tjs.remove(`${cacheRoot}/${item.name}`, { recursive: true });
        } catch {}
      }
    }
  } catch {}
}

export async function setupNativeLibs(): Promise<void> {
  if (NATIVE_LIBS.length === 0) return; // dev/test build (--no-embed): env comes from mise
  const pending = NATIVE_LIBS.filter((lib) => {
    const envVar = envVarFor(lib.name);
    return envVar !== undefined && (tjs.env[envVar] ?? '') === '';
  });
  if (pending.length === 0) return;
  let root = defaultCacheRoot();
  let paths: Record<string, string>;
  try {
    paths = await extractLibs(pending, NATIVE_LIBS_HASH, root);
  } catch {
    try {
      root = `${tjs.tmpDir}/deckbridge`;
      paths = await extractLibs(pending, NATIVE_LIBS_HASH, root);
    } catch (e) {
      log('error', 'native-libs', `extraction failed: ${(e as Error).message}`);
      return;
    }
  }
  for (const lib of pending) {
    const envVar = envVarFor(lib.name)!;
    tjs.env[envVar] = paths[lib.name]!;
  }
  log(
    'info',
    'native-libs',
    `extracted ${pending.length} lib(s) to ${root}/native-${NATIVE_LIBS_HASH}`,
  );
  void cleanupOldHashDirs(root, NATIVE_LIBS_HASH);
}
