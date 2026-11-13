// Shared micro-harness for the tjs test suite (tjs:assert, not vitest).
//
// NOTE: this file is intentionally NOT named `*.test.ts` so scripts/run-tests.mjs
// (which globs `test/*.test.ts`) never runs it as a standalone test — it is only
// imported by the real test files and bundled in via esbuild.
//
// Module-level counters are safe because run-tests.mjs bundles and runs each test
// file as its own process, so no two files ever share a tally.

let passed = 0;
let failed = 0;

function recordPass(name: string): void {
  console.log(`  ✓ ${name}`);
  passed++;
}

function recordFail(name: string, e: unknown): void {
  console.error(`  ✗ ${name}: ${(e as Error).message}`);
  failed++;
}

/** Sync test case. */
export function test(name: string, fn: () => void): void {
  try {
    fn();
    recordPass(name);
  } catch (e) {
    recordFail(name, e);
  }
}

/** Async (or sync-or-async) test case. Call sites `await` it to keep ordering. */
export async function testAsync(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    recordPass(name);
  } catch (e: unknown) {
    recordFail(name, e);
  }
}

/**
 * Print the tally; exit non-zero only on failure, otherwise let the event loop
 * drain (some suites rely on that to flush pending async writes, e.g. log-file).
 */
export function summary(): void {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) tjs.exit(1);
}

/**
 * Print the tally and always exit. Use where lingering handles (servers, workers,
 * timers) would otherwise keep the process alive after the last assertion.
 */
export function summaryExit(): void {
  console.log(`\n${passed} passed, ${failed} failed`);
  tjs.exit(failed > 0 ? 1 : 0);
}
