import assert from 'tjs:assert';
import {
  activeCommandCount,
  COMMAND_OUTPUT_MAX_BYTES,
  runCommand,
  stopCommands,
} from '../src/infra/command-runner.js';
import { platformName } from '../src/infra/os-utils.js';
import { testAsync as test, summaryExit } from './helpers/harness.js';

// Kill timeouts (250 ms grace, 1000 ms ceiling) plus scheduling slack.
const CLEANUP_ALLOWANCE_MS = 1500;
const tmp = `${tjs.tmpDir}/command-runner-test-${tjs.pid}`;

async function rejects(p: Promise<unknown>, match: RegExp): Promise<void> {
  try {
    await p;
  } catch (e) {
    assert.ok(match.test((e as Error).message), `unexpected error: ${(e as Error).message}`);
    return;
  }
  throw new Error('expected a rejection');
}

async function readPid(file: string): Promise<number | null> {
  try {
    const text = new TextDecoder().decode(await tjs.readFile(file));
    const pid = Number(text.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function alive(pid: number): Promise<boolean> {
  const p = tjs.spawn(['kill', '-0', String(pid)], { stdout: 'ignore', stderr: 'ignore' });
  return (await p.wait()).exit_status === 0;
}

/** Fixtures record descendant PIDs so survivors are cleaned even when a test fails. */
async function killSurvivor(file: string): Promise<void> {
  const pid = await readPid(file);
  if (pid !== null) await tjs.spawn(['kill', '-9', String(pid)], { stderr: 'ignore' }).wait();
}

if (platformName() === 'Windows') {
  console.log('  (POSIX shell fixtures — skipped on Windows)');
} else {
  await tjs.makeDir(tmp, { recursive: true });

  await test('success: complete stdout, nothing left registered', async () => {
    assert.equal(await runCommand('printf hello', 2000), 'hello');
    assert.equal(activeCommandCount(), 0);
  });

  await test('a UTF-8 sequence split across reads survives the final flush', async () => {
    const out = await runCommand("printf '\\303'; sleep 0.05; printf '\\251'", 2000);
    assert.equal(out, 'é');
  });

  await test('a descendant holding stdout cannot outlive the deadline', async () => {
    const pidFile = `${tmp}/descendant.pid`;
    try {
      const t0 = Date.now();
      // The shell exits at once; the backgrounded subshell keeps the pipe open.
      await rejects(
        runCommand(`(sleep 3; printf late) & echo $! > ${pidFile}; printf early`, 50),
        /timed out/,
      );
      const took = Date.now() - t0;
      assert.ok(took < 50 + CLEANUP_ALLOWANCE_MS, `settled after ${took}ms`);
      assert.equal(activeCommandCount(), 0);
    } finally {
      await killSurvivor(pidFile);
    }
  });

  await test('a shell ignoring TERM is escalated to KILL', async () => {
    const t0 = Date.now();
    await rejects(runCommand("trap '' TERM; while :; do sleep 0.02; done", 50), /timed out/);
    const took = Date.now() - t0;
    assert.ok(took < 50 + CLEANUP_ALLOWANCE_MS, `settled after ${took}ms`);
  });

  await test('the shell is reaped after a timeout', async () => {
    const pidFile = `${tmp}/shell.pid`;
    await rejects(runCommand(`echo $$ > ${pidFile}; sleep 5`, 50), /timed out/);
    const pid = await readPid(pidFile);
    if (pid === null) throw new Error('shell pid not recorded');
    assert.ok(!(await alive(pid)), 'shell gone');
    // `sleep 5` is a descendant: the known F03 gap until the runtime owns process trees.
    await tjs.spawn(['pkill', '-P', String(pid)], { stderr: 'ignore' }).wait();
  });

  await test('output over the cap fails the command explicitly', async () => {
    await rejects(
      runCommand(`yes | head -c ${COMMAND_OUTPUT_MAX_BYTES + 4096}`, 5000),
      /output exceeded/,
    );
    assert.equal(activeCommandCount(), 0);
  });

  await test('an abort signal cancels the command', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    await rejects(runCommand('sleep 5', 10_000, { signal: ac.signal }), /cancelled/);
  });

  await test('repeated timeout cycles leave nothing registered', async () => {
    for (let i = 0; i < 20; i++) {
      await rejects(runCommand('sleep 1', 10 + (i % 3) * 20), /timed out/);
    }
    assert.equal(activeCommandCount(), 0);
  });

  // Last: stopCommands() is terminal for the process.
  await test('stopCommands cancels running commands and refuses new ones', async () => {
    const running = runCommand('sleep 5', 10_000);
    await new Promise((r) => setTimeout(r, 30));
    const t0 = Date.now();
    await stopCommands();
    assert.ok(Date.now() - t0 < CLEANUP_ALLOWANCE_MS);
    await rejects(running, /shutdown/);
    assert.equal(activeCommandCount(), 0);
    await rejects(runCommand('printf x', 1000), /stopped/);
  });

  await tjs.remove(tmp, { recursive: true }).catch(() => undefined);
}

summaryExit();
