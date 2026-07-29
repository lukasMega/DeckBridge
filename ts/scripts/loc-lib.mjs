// ts/scripts/loc-lib.mjs — shared .ts/.tsx file walk + line counts for loc.mjs / check-loc.mjs.
// Scoped to ts/src (skips node_modules/dist/coverage/test and .d.ts) — test files
// run larger by nature (fixtures/table-driven cases), so they don't share the src limit.

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', 'test']);

async function collectFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(full)));
    } else if ((entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) && !entry.name.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

export async function lineCounts(root) {
  const files = await collectFiles(root);
  return Promise.all(
    files.map(async (file) => {
      const text = await readFile(file, 'utf8');
      return { file: relative(root, file), lines: text.split('\n').length };
    }),
  );
}
