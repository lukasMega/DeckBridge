// Watches for a lost DeckBridge and re-probes it until it answers, so the relay can follow an
// identity change (new model or serial) after a restart. Sockets, timers and logging are
// injected, which keeps it testable without a network.
import type { DockIdentity } from './identity.js';
import type { RelayPortName } from './relay.js';

export type RecoveryLog = (level: 'info' | 'warn' | 'error', message: string) => void;

export interface UpstreamWatcherDeps {
  probe: () => Promise<DockIdentity>;
  sleep: (ms: number, stop: Promise<void>) => Promise<void>;
  stop: Promise<void>;
  isStopped: () => boolean;
  log: RecoveryLog;
  /** Called only when the identity differs from the last known one. */
  onRecovered: (prev: DockIdentity, next: DockIdentity) => void | Promise<void>;
  backoffMs?: readonly number[];
  now?: () => number;
}

export const RECOVERY_BACKOFF_MS: readonly number[] = [1000, 2000, 5000];

export function sleep(ms: number, stop: Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    void stop.then(() => {
      clearTimeout(t);
      resolve();
      return undefined;
    });
  });
}

function describeChange(prev: DockIdentity, next: DockIdentity): string[] {
  const out: string[] = [];
  if (prev.serial !== next.serial) out.push(`serial ${prev.serial} -> ${next.serial}`);
  if (prev.productId !== next.productId) {
    out.push(`pid 0x${prev.productId.toString(16)} -> 0x${next.productId.toString(16)}`);
  }
  if (prev.childPort !== next.childPort)
    out.push(`child port ${prev.childPort} -> ${next.childPort}`);
  return out;
}

/** Returns the `onUpstreamLost` callback; it never throws and runs one recovery at a time. */
export function createUpstreamWatcher(
  initial: DockIdentity,
  deps: UpstreamWatcherDeps,
): (route: RelayPortName, reason: string) => void {
  const backoff =
    deps.backoffMs !== undefined && deps.backoffMs.length > 0
      ? deps.backoffMs
      : RECOVERY_BACKOFF_MS;
  const now = deps.now ?? Date.now;
  let last = initial;
  let running = false;

  async function recover(): Promise<void> {
    const startedAt = now();
    let failed = false;
    let attempt = 0;
    let next: DockIdentity | null = null;
    while (next === null && !deps.isStopped()) {
      try {
        next = await deps.probe();
      } catch (e) {
        if (!failed) {
          failed = true;
          deps.log('warn', `DeckBridge unreachable, retrying (${(e as Error).message})`);
        }
        await deps.sleep(backoff[Math.min(attempt, backoff.length - 1)]!, deps.stop);
        attempt++;
      }
    }
    if (next === null || deps.isStopped()) return;
    if (failed) {
      deps.log('info', `DeckBridge back after ${((now() - startedAt) / 1000).toFixed(1)} s`);
    }
    const prev = last;
    const changes = describeChange(prev, next);
    last = next;
    if (changes.length === 0) return;
    deps.log('warn', `DeckBridge identity changed: ${changes.join(', ')}`);
    try {
      await deps.onRecovered(prev, next);
    } catch (e) {
      deps.log('error', `following the new identity failed: ${(e as Error).message}`);
    }
  }

  return function onUpstreamLost(): void {
    // A burst of lost events (several sessions) must start one recovery only.
    if (running || deps.isStopped()) return;
    running = true;
    recover()
      .catch((e: unknown) => {
        deps.log('error', `recovery failed: ${(e as Error).message}`);
      })
      .finally(() => {
        running = false;
      });
  };
}
