import assert from 'tjs:assert';
import { DIGEST_LIMITS, readFolderFiles } from '../src/web/server/extension-digest.js';
import type { FolderRead } from '../src/web/server/extension-digest.js';
import { test, testAsync as runTest, summaryExit } from './helpers/harness.js';

const ROOT = `${tjs.tmpDir}/extension-digest-test-${tjs.pid}`;
const dirFor = (name: string): string => `${ROOT}/${name}`;
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

async function folder(name: string, files: Record<string, string>): Promise<string> {
  const dir = dirFor(name);
  await tjs.makeDir(dir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const path = `${dir}/${rel}`;
    const slash = path.lastIndexOf('/');
    await tjs.makeDir(path.slice(0, slash), { recursive: true });
    await tjs.writeFile(path, body);
  }
  return dir;
}

function expectFiles(
  read: FolderRead,
): asserts read is { digest: string; files: Map<string, Uint8Array> } {
  if ('problem' in read) throw new Error(`unexpected problem: ${read.problem}`);
}

function expectProblem(read: FolderRead, prefix: string): void {
  if (!('problem' in read)) throw new Error(`expected a problem starting "${prefix}"`);
  assert.ok(read.problem.startsWith(prefix), `"${read.problem}" starts with "${prefix}"`);
}

await runTest('golden vector matches shasum -a 256 over sorted paths', async () => {
  const dir = await folder('golden', {
    'manifest.json': '{"id":"golden"}',
    'server.js': 'export default () => ({});',
    'lib/util.js': 'export const x = 1;',
    '.DS_Store': 'junk',
    signature: 'sig',
  });
  const read = await readFolderFiles(dir);
  expectFiles(read);
  assert.equal(read.digest, 'b40452fb2fa73dadf1f52a69123b3a75457a8cf4319a5d54275e1652e31649a1');
  assert.deepEqual([...read.files.keys()], ['lib/util.js', 'manifest.json', 'server.js']);
});

await runTest('changing one byte changes the digest', async () => {
  const dir = await folder('one-byte', { 'lib/util.js': 'export const x = 1;' });
  const before = await readFolderFiles(dir);
  expectFiles(before);
  await tjs.writeFile(`${dir}/lib/util.js`, 'export const x = 2;');
  const after = await readFolderFiles(dir);
  expectFiles(after);
  assert.notEqual(before.digest, after.digest);
});

await runTest('a nested signature file is hashed, only the top-level one is skipped', async () => {
  const dir = await folder('nested-signature', { 'lib/signature': 'sig' });
  const read = await readFolderFiles(dir);
  expectFiles(read);
  assert.deepEqual([...read.files.keys()], ['lib/signature']);
});

await runTest('a symlink inside the folder is a problem', async () => {
  const dir = await folder('symlink', { 'server.js': 'export default () => ({});' });
  await tjs.symlink(`${dir}/server.js`, `${dir}/link.js`);
  expectProblem(await readFolderFiles(dir), 'contains a symlink');
});

await runTest('a file name with a space is a problem', async () => {
  const dir = await folder('bad-name', { 'a b.js': 'x' });
  expectProblem(await readFolderFiles(dir), 'unsupported file name');
});

await runTest('65 files is a problem', async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i <= DIGEST_LIMITS.files; i++) files[`f${i}.js`] = 'x';
  const dir = await folder('too-many', files);
  expectProblem(await readFolderFiles(dir), 'more than 64 files');
});

await runTest('five nested folders is a problem', async () => {
  const dir = await folder('too-deep', { 'a/b/c/d/e/f.js': 'x' });
  expectProblem(await readFolderFiles(dir), 'folders nested deeper than 4');
});

await runTest('four nested folders is allowed', async () => {
  const dir = await folder('deep-ok', { 'a/b/c/d/f.js': 'x' });
  const read = await readFolderFiles(dir);
  expectFiles(read);
  assert.deepEqual([...read.files.keys()], ['a/b/c/d/f.js']);
});

await runTest('a missing folder is reported as unreadable', async () => {
  expectProblem(await readFolderFiles(dirFor('does-not-exist')), 'cannot read folder');
});

await runTest('file bytes are returned unchanged', async () => {
  const dir = await folder('bytes', { 'server.js': 'héllo' });
  const read = await readFolderFiles(dir);
  expectFiles(read);
  assert.equal(text(read.files.get('server.js') as Uint8Array), 'héllo');
});

test('limits match the documented values', () => {
  assert.deepEqual(DIGEST_LIMITS, { files: 64, bytes: 4 * 1024 * 1024, depth: 4 });
});

await tjs.remove(ROOT, { recursive: true }).catch(() => undefined);
summaryExit();
