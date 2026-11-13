// Shell runner behind the command widget, knob commands and extra-key press commands.
// One owner per invocation: a deadline, an output cap, or shutdown cancels the stdout
// reader and kills the shell, so a descendant still holding the pipe can't keep the
// caller (and its command slot) waiting for EOF.
//
// Known gap (performance review F03): only the shell itself is killed. Descendants it
// started survive until they exit on their own — txiki's spawn has no process-group or
// job-object option yet. See .claude/plans (P1 plan, Stage 0).
import { platformName } from './os-utils.js';

/** SIGTERM → SIGKILL grace once a command is cancelled. */
const KILL_GRACE_MS = 250;
/** Longest a cancelled command waits for the shell to exit before giving up on it. */
const CLEANUP_CEILING_MS = 1000;
/** Retained stdout ceiling; more output fails the command instead of growing memory. */
export const COMMAND_OUTPUT_MAX_BYTES = 1024 * 1024;

const active = new Set<{ cancel(reason: Error): void; done: Promise<unknown> }>();
let stopped = false;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function killQuietly(p: TjsProcess, signal: string): void {
  try {
    p.kill(signal);
  } catch {
    // already exited
  }
}

/** Run `cmd` through the platform shell and resolve its stdout. Rejects on timeout,
 *  output over COMMAND_OUTPUT_MAX_BYTES, `signal` abort, or after stopCommands();
 *  a rejection never carries partial output. */
export async function runCommand(
  cmd: string,
  timeoutMs: number,
  opts: { signal?: AbortSignal } = {},
): Promise<string> {
  if (stopped) throw new Error('command runner stopped');
  if (opts.signal?.aborted) throw new Error('command cancelled');

  // An object, not a `let`: TS would narrow a closure-assigned local to null.
  const state: { failure: Error | null; exited: boolean } = { failure: null, exited: false };
  const failed = Promise.withResolvers<void>();
  const fail = (err: Error): void => {
    if (state.failure) return;
    state.failure = err;
    failed.resolve();
  };

  const args = platformName() === 'Windows' ? ['cmd', '/c', cmd] : ['sh', '-c', cmd];
  const p = tjs.spawn(args, { stdout: 'pipe', stderr: 'ignore' });
  const reader = p.stdout.getReader();
  const exit = p.wait().then((r) => {
    state.exited = true;
    return r;
  });

  const entry = { cancel: fail, done: Promise.resolve() as Promise<unknown> };
  active.add(entry);
  const deadline = setTimeout(
    () => fail(new Error(`command timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  const onAbort = (): void => fail(new Error('command cancelled'));
  opts.signal?.addEventListener('abort', onAbort);

  const read = (async (): Promise<string> => {
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > COMMAND_OUTPUT_MAX_BYTES) {
        throw new Error(`command output exceeded ${COMMAND_OUTPUT_MAX_BYTES} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
    // The trailing decode() flushes a UTF-8 sequence split across the last chunk.
    return text + decoder.decode();
  })();
  read.catch((e: unknown) => fail(e instanceof Error ? e : new Error(String(e))));

  const run = (async (): Promise<string> => {
    // Both EOF and shell exit, under one deadline: the shell exiting first must not
    // disarm it while a descendant still writes.
    const outcome = await Promise.race([Promise.all([read, exit]), failed.promise]);
    if (outcome && !state.failure) return outcome[0];
    await reader.cancel().catch(() => undefined);
    const hasExited = (): boolean => state.exited;
    if (!hasExited()) {
      killQuietly(p, 'SIGTERM');
      await Promise.race([exit, sleep(KILL_GRACE_MS)]);
      if (!hasExited()) killQuietly(p, 'SIGKILL');
      await Promise.race([exit, sleep(CLEANUP_CEILING_MS - KILL_GRACE_MS)]);
    }
    throw state.failure ?? new Error('command failed');
  })();
  entry.done = run.catch(() => undefined);

  try {
    return await run;
  } finally {
    clearTimeout(deadline);
    opts.signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
    active.delete(entry);
  }
}

/** Shutdown: refuse new commands, cancel every running one, and wait for them to settle. */
export async function stopCommands(): Promise<void> {
  stopped = true;
  const running = [...active];
  for (const entry of running) entry.cancel(new Error('command cancelled by shutdown'));
  await Promise.all(running.map((e) => e.done));
}

/** Commands currently owned by the runner (tests). */
export function activeCommandCount(): number {
  return active.size;
}
