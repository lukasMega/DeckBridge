import assert from 'tjs:assert';
import { parentDir, isAbsolutePath } from '../src/tray.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

async function asyncTest(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

// ── parentDir ─────────────────────────────────────────────────────────────────

console.log('\nparentDir');

test('Unix path → parent directory', () => {
  assert.equal(parentDir('/usr/local/bin/tray'), '/usr/local/bin');
});

test('single-segment Unix path → parent directory', () => {
  assert.equal(parentDir('/usr/tray'), '/usr');
});

test('Windows path → parent directory', () => {
  assert.equal(parentDir('C:\\Users\\user\\tray.exe'), 'C:\\Users\\user');
});

test('no separator → dot', () => {
  assert.equal(parentDir('tray'), '.');
});

test('root-only slash → dot (i = 0, not > 0)', () => {
  assert.equal(parentDir('/tray'), '.');
});

// ── isAbsolutePath ────────────────────────────────────────────────────────────

console.log('\nisAbsolutePath');

test('Unix absolute path → true', () => {
  assert.ok(isAbsolutePath('/usr/local/bin/tray'));
});

test('Windows absolute path (uppercase drive) → true', () => {
  assert.ok(isAbsolutePath('C:\\Users\\tray.exe'));
});

test('Windows absolute path (lowercase drive) → true', () => {
  assert.ok(isAbsolutePath('c:/Users/tray.exe'));
});

test('Windows absolute path (mixed case) → true', () => {
  assert.ok(isAbsolutePath('Z:\\tray.exe'));
});

test('relative path → false', () => {
  assert.ok(!isAbsolutePath('tray'));
});

test('relative path with directory → false', () => {
  assert.ok(!isAbsolutePath('go/tray-go'));
});

test('drive letter without colon → false', () => {
  assert.ok(!isAbsolutePath('Ctray.exe'));
});

// ── TrayProcess.close() kills the spawned process (L1) ───────────────────────
// TrayProcess.proc is private and not directly reachable from a test without a
// real tray-go binary, so this exercises the same TjsProcess.kill('SIGTERM')
// call that TrayProcess.close() now makes on a trivial long-running child, to
// verify the API behaves as close() relies on (process stops after SIGTERM).

console.log('\nTrayProcess.close() process termination (L1)');

await asyncTest('SIGTERM stops a spawned child process', async () => {
  const proc = tjs.spawn(['cat'], { stdout: 'ignore', stderr: 'ignore' });
  proc.kill('SIGTERM');
  const { exit_status, term_signal } = await proc.wait();
  // 'cat' with no explicit handler dies on SIGTERM: either a non-zero exit
  // status or a recorded term_signal, depending on platform reporting.
  assert.ok(exit_status !== 0 || term_signal !== null);
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) tjs.exit(1);
