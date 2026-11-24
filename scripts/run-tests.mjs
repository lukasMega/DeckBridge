#!/usr/bin/env node
// Run the txiki.js test suite. For each ts/test/*.test.ts: bundle it, then run it
// under $TJS. Silent on success except one summary line (VERBOSE=1 prints a line per
// passing file). On a build or run failure (including SIGSEGV), prints the captured
// output and exit status. Continues past failures; exits non-zero if any test failed.
//
// Env (provided by mise): TJS, DECKBRIDGE_NATIVE_LIB. Invoked by [tasks.test] in mise.toml.
// `--node`: only the relay core tests, on Node.js via ts/src/node/tjs-shim.ts ([tasks.test-relay-node]):
// the Node.js relay (deckbridge-relay-v<ver>.mjs) ships that same code.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const tsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'ts');
const nodeMode = process.argv.includes('--node');
const NODE_TESTS = /^relay-(?:args|connect|core|hold|identity|recovery)\.test\.ts$/;
const tjs = process.env.TJS;
if (!tjs && !nodeMode) {
  console.error('TJS env var not set — run via `mise run test`');
  process.exit(1);
}

// These run only on CI (CI env var set by GitHub Actions) — too slow for local iteration.
const CI_ONLY_TESTS = new Set([
  'hash-bench.test.ts',
  'image-cache.test.ts',
  'image-copy-bench.test.ts',
]);

const opts = { cwd: tsDir, encoding: 'utf8' };
const files = readdirSync(join(tsDir, 'test'))
  .filter((f) => f.endsWith('.test.ts'))
  .filter((f) => process.env.CI || !CI_ONLY_TESTS.has(f))
  .filter((f) => !nodeMode || NODE_TESTS.test(f))
  .sort();

const PORT_RETRIES = 2;
const isPortClash = (run) => `${run.stdout ?? ''}${run.stderr ?? ''}`.includes('EADDRINUSE');

const verbose = Boolean(process.env.VERBOSE);
let rc = 0;
let failed = 0;
for (const file of files) {
  const startedAt = process.hrtime.bigint();
  const name = file.slice(0, -'.test.ts'.length);
  const label = `ts/test/${file}`;
  const duration = () => {
    const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    return seconds > 0.5 ? ` ⏲ (${seconds.toFixed(2)}s)` : '';
  };

  const build = spawnSync('node', ['build.mjs', '--test', name, ...(nodeMode ? ['--node'] : [])], opts);
  if (build.status !== 0) {
    console.log(`✘ ${label}${duration()}`);
    process.stdout.write((build.stdout ?? '') + (build.stderr ?? ''));
    console.log(`  build exit ${build.status ?? `signal ${build.signal}`}`);
    rc = 1;
    failed++;
    continue;
  }

  const runOnce = () =>
    nodeMode
      ? spawnSync('node', [`dist/test-node/${name}.mjs`], opts)
      : spawnSync(tjs, ['run', `dist/test/${name}.js`], opts);
  let run = runOnce();
  // A fixed test port can be taken by another process's outgoing socket; that is not a test failure.
  for (let retry = 1; retry <= PORT_RETRIES && run.status !== 0 && isPortClash(run); retry++) {
    console.log(`↻ ${label}: EADDRINUSE, retry ${retry}/${PORT_RETRIES}`);
    run = runOnce();
  }
  if (run.status !== 0) {
    console.log(`✘ ${label}${duration()}`);
    process.stdout.write((run.stdout ?? '') + (run.stderr ?? ''));
    // status is null when the process is killed by a signal (e.g. SIGSEGV).
    console.log(`  exit ${run.status ?? `signal ${run.signal}`}`);
    rc = 1;
    failed++;
    continue;
  }

  if (verbose) console.log(`✔ ${label}${duration()}`);
}

const runtime = nodeMode ? ' on Node.js' : '';
console.log(
  failed
    ? `✘ tests${runtime}: ${failed} of ${files.length} files failed`
    : `✔ tests${runtime} (${files.length} files)`,
);

process.exit(rc);
