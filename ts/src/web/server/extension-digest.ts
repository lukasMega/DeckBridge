// Digest of every file in an extension folder: what the user switched on, so a later change
// is detected (docs/extensions.md). The text hashed is `sha256sum` output over the sorted
// paths, so a shell or the release script can reproduce it.

/** OS clutter, skipped at any depth. */
const CLUTTER = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
/** Top level only: the release signature signs the digest, so it cannot be part of it. */
const SIGNATURE_FILE = 'signature';
const NAME = /^[\w.-]{1,64}$/;
export const DIGEST_LIMITS = { files: 64, bytes: 4 * 1024 * 1024, depth: 4 } as const;

export type FolderRead = { digest: string; files: Map<string, Uint8Array> } | { problem: string };

/** An expected rejection. Any other thrown error means the folder could not be read. */
class FolderProblem extends Error {}

type WalkState = { files: Map<string, Uint8Array>; bytes: number };
type Entry = { name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean };

const hex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

const sha256hex = async (data: Uint8Array): Promise<string> =>
  hex(await crypto.subtle.digest('SHA-256', data as BufferSource));

const skipped = (name: string, topLevel: boolean): boolean =>
  CLUTTER.has(name) || (topLevel && name === SIGNATURE_FILE);

async function walk(dir: string, prefix: string, state: WalkState): Promise<void> {
  for await (const entry of await tjs.readDir(dir)) {
    if (skipped(entry.name, prefix === '')) continue;
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    await visit(`${dir}/${entry.name}`, rel, entry, state);
  }
}

async function visit(path: string, rel: string, entry: Entry, state: WalkState): Promise<void> {
  if (!NAME.test(entry.name)) throw new FolderProblem(`unsupported file name: ${rel}`);
  if (entry.isSymbolicLink) throw new FolderProblem(`contains a symlink: ${rel}`);
  if (entry.isDirectory) {
    if (rel.split('/').length > DIGEST_LIMITS.depth)
      throw new FolderProblem(`folders nested deeper than ${DIGEST_LIMITS.depth}: ${rel}`);
    return walk(path, rel, state);
  }
  if (!entry.isFile) throw new FolderProblem(`not a regular file: ${rel}`);
  if (state.files.size >= DIGEST_LIMITS.files)
    throw new FolderProblem(`more than ${DIGEST_LIMITS.files} files`);
  const bytes = await tjs.readFile(path);
  state.bytes += bytes.byteLength;
  if (state.bytes > DIGEST_LIMITS.bytes)
    throw new FolderProblem(`files over ${DIGEST_LIMITS.bytes / (1024 * 1024)} MB in total`);
  state.files.set(rel, bytes);
}

/** Reads the folder, or says why it cannot be trusted. The folder itself may be a symlink. */
export async function readFolderFiles(dir: string): Promise<FolderRead> {
  const state: WalkState = { files: new Map(), bytes: 0 };
  try {
    await walk(dir, '', state);
  } catch (err) {
    if (err instanceof FolderProblem) return { problem: err.message };
    return { problem: `cannot read folder: ${err instanceof Error ? err.message : String(err)}` };
  }
  const paths = [...state.files.keys()].toSorted((a, b) => (a < b ? -1 : Number(a > b)));
  let text = '';
  for (const rel of paths) {
    const hash = await sha256hex(state.files.get(rel) as Uint8Array);
    text += `${hash}  ${rel}\n`;
  }
  const digest = await sha256hex(new TextEncoder().encode(text));
  const files = new Map(paths.map((rel) => [rel, state.files.get(rel) as Uint8Array]));
  return { digest, files };
}
