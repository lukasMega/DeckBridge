#!/usr/bin/env node
// Run the txiki.js test suite. For each ts/test/*.test.ts: bundle it, then run it
// under $TJS. Prints one line per test file (relative to project root). On a build
// or run failure (including SIGSEGV), prints the captured output and exit status.
// Continues past failures; exits non-zero if any test failed.
//
// Env (provided by mise): TJS, DECKBRIDGE_NATIVE_LIB. Invoked by [tasks.test] in mise.toml.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const tsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'ts');
const tjs = process.env.TJS;
if (!tjs) {
  console.error('TJS env var not set — run via `mise run test`');
  process.exit(1);
}

// These run only on CI (CI env var set by GitHub Actions) — too slow for local iteration.
const CI_ONLY_TESTS = new Set(['hash-bench.test.ts', 'image-cache.test.ts']);

const opts = { cwd: tsDir, encoding: 'utf8' };
const files = readdirSync(join(tsDir, 'test'))
  .filter((f) => f.endsWith('.test.ts'))
  .filter((f) => process.env.CI || !CI_ONLY_TESTS.has(f))
  .sort();

let rc = 0;
for (const file of files) {
  const startedAt = process.hrtime.bigint();
  const name = file.slice(0, -'.test.ts'.length);
  const label = `ts/test/${file}`;
  const duration = () => {
    const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    return seconds > 0.5 ? ` ⏲ (${seconds.toFixed(2)}s)` : '';
  };

  const build = spawnSync('node', ['build.mjs', '--test', name], opts);
  if (build.status !== 0) {
    console.log(`✘ ${label}${duration()}`);
    process.stdout.write((build.stdout ?? '') + (build.stderr ?? ''));
    console.log(`  build exit ${build.status ?? `signal ${build.signal}`}`);
    rc = 1;
    continue;
  }

  const run = spawnSync(tjs, ['run', `dist/test/${name}.js`], opts);
  if (run.status !== 0) {
    console.log(`✘ ${label}${duration()}`);
    process.stdout.write((run.stdout ?? '') + (run.stderr ?? ''));
    // status is null when the process is killed by a signal (e.g. SIGSEGV).
    console.log(`  exit ${run.status ?? `signal ${run.signal}`}`);
    rc = 1;
    continue;
  }

  console.log(`✔ ${label}${duration()}`);
}

process.exit(rc);
