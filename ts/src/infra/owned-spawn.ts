// Spawn owner for fire-and-forget children (update-check / daily-ping curl, OS probes).
// Shutdown kills whatever is in flight and refuses new spawns, so a quit during a check
// settles at once instead of waiting out the curl timeout against the shutdown budget.
const KILL_GRACE_MS = 250;
const CLEANUP_CEILING_MS = 1000;

const active = new Set<{ proc: TjsProcess; exited: Promise<unknown> }>();
let stopped = false;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function killQuietly(p: TjsProcess, signal: string): void {
  try {
    p.kill(signal);
  } catch {
    // already exited
  }
}

export function spawnsStopped(): boolean {
  return stopped;
}

/** `tjs.spawn` that shutdown can cancel. Throws once stopped, like a missing binary. */
export function spawnOwned(args: string[], opts: Parameters<typeof tjs.spawn>[1]): TjsProcess {
  if (stopped) throw new Error('spawns stopped');
  const proc = tjs.spawn(args, opts);
  const entry = { proc, exited: Promise.resolve() as Promise<unknown> };
  entry.exited = proc.wait().then(
    () => active.delete(entry),
    () => active.delete(entry),
  );
  active.add(entry);
  return proc;
}

/** Shutdown: refuse new spawns, SIGTERM then SIGKILL the running ones, wait (bounded). */
export async function stopSpawns(): Promise<void> {
  stopped = true;
  const running = [...active];
  for (const e of running) killQuietly(e.proc, 'SIGTERM');
  const all = Promise.all(running.map((e) => e.exited));
  await Promise.race([all, sleep(KILL_GRACE_MS)]);
  for (const e of active) killQuietly(e.proc, 'SIGKILL');
  await Promise.race([all, sleep(CLEANUP_CEILING_MS - KILL_GRACE_MS)]);
}
