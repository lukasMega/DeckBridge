// Application shutdown order: stop producers synchronously, close every owner
// concurrently under one budget, then write the final settings, then drain the log,
// then exit once. A failing or hung owner never stops the later steps; it only turns
// the exit status into a failure. Callers share one run (signals, tray Quit, crash).
import { log } from '../shared/logger.js';

export type ShutdownOwner = readonly [name: string, close: () => Promise<unknown>];

export interface ShutdownPlan {
  /** Synchronous: terminal flag, timers, gates — before any await. */
  quiesce(): void;
  /** Closed concurrently; each keeps its own internal order. */
  owners: readonly ShutdownOwner[];
  /** Final settings write; false = it failed (already logged by the writer). */
  persist(): Promise<boolean>;
  drainLogs(): Promise<unknown>;
  exit(code: number): void;
}

export const SHUTDOWN_BUDGET_MS = 10_000;
/** Kept out of the owners' share of the budget, so the settings write always gets a turn. */
export const PERSIST_RESERVE_MS = 2_000;
const LOG_DRAIN_MS = 1_000;

/** Resolves true if `p` settles within `ms`. */
async function within(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, ms));
  });
  try {
    return await Promise.race([p.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Returns the shutdown trigger; every call returns the same run. */
export function createShutdown(
  plan: ShutdownPlan,
  budgetMs = SHUTDOWN_BUDGET_MS,
  persistReserveMs = PERSIST_RESERVE_MS,
): () => Promise<void> {
  let running: Promise<void> | null = null;
  return () => (running ??= run(plan, budgetMs, persistReserveMs));
}

async function run(plan: ShutdownPlan, budgetMs: number, persistReserveMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  let ok = true;
  try {
    plan.quiesce();
  } catch (e) {
    ok = false;
    log('error', 'deckBr', `shutdown: quiesce failed: ${message(e)}`);
  }

  const open = new Set(plan.owners.map(([name]) => name));
  const closing = plan.owners.map(async ([name, close]) => {
    try {
      await close();
    } catch (e) {
      ok = false;
      log('error', 'deckBr', `shutdown: ${name} failed: ${message(e)}`);
    } finally {
      open.delete(name);
    }
  });
  if (!(await within(Promise.all(closing), deadline - persistReserveMs - Date.now()))) {
    ok = false;
    log('error', 'deckBr', `shutdown: still open after the budget: ${[...open].join(', ')}`);
  }

  const result = { saved: false };
  const persisting = (async (): Promise<void> => {
    result.saved = await plan.persist();
  })();
  const persisted = await within(persisting, Math.max(persistReserveMs, deadline - Date.now()));
  if (!persisted || !result.saved) {
    ok = false;
    log('error', 'deckBr', 'shutdown: the last settings change may not be saved');
  }

  // Owner completion is not success yet: the final drain can still fail.
  log(ok ? 'info' : 'warn', 'deckBr', ok ? 'shutdown: owners closed' : 'shutdown incomplete');
  const drain: { error?: unknown } = {};
  // Catch inside the task so a late rejection after the timeout stays observed.
  const draining = (async (): Promise<void> => {
    try {
      await plan.drainLogs();
    } catch (e) {
      drain.error = e ?? new Error('log drain failed');
    }
  })();
  const drained = await within(draining, LOG_DRAIN_MS);
  if (!drained || drain.error !== undefined) {
    ok = false;
    // The file sink is detached by now (or failed), so this reaches the console only.
    const why = drained ? `failed: ${message(drain.error)}` : 'timed out';
    console.error(`shutdown: log drain ${why}`);
  } else if (ok) {
    log('info', 'deckBr', 'shutdown complete');
  }
  plan.exit(ok ? 0 : 1);
}
