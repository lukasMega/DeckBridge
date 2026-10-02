#!/usr/bin/env node
// Run a command silently: print its output only on failure or when it carries real
// diagnostics (warnings), plus an optional one-line success message.
// Usage: node scripts/quiet.mjs [--ok=MSG] [--fail-only] -- cmd args...
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const flags = argv.slice(0, sep);
const [cmd, ...args] = argv.slice(sep + 1);
const okMsg = flags.find((f) => f.startsWith('--ok='))?.slice('--ok='.length);
// --fail-only: cargo-style tools whose success output is all progress chatter and whose
// warnings are already promoted to errors (-D warnings).
const failOnly = flags.includes('--fail-only');

const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const out = (r.stdout ?? '') + (r.stderr ?? '');
// Success summaries of oxlint/oxfmt carry no information when clean.
const NOISE = /^(Found 0 warnings and 0 errors\.|Finished in .*|\s*)$/;
const residue = out.split('\n').some((line) => !NOISE.test(line));

if (r.status !== 0 || (!failOnly && residue)) {
  process.stdout.write(out);
  if (r.status !== 0) {
    console.log(`✘ ${cmd} exit ${r.status ?? `signal ${r.signal}`}`);
    process.exit(r.status ?? 1);
  }
} else if (okMsg) {
  console.log(`✔ ${okMsg}`);
}
