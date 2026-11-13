// Per-dock sleepCommand / wakeCommand runner. SECURITY: arbitrary shell from
// settings.json, same trust model as the command widget (see docs/features.md).
import { runCommand } from '../infra/command-runner.js';
import { log } from '../shared/logger.js';
import type { StandbySettings } from '../shared/types.js';

export const STANDBY_COMMAND_TIMEOUT_MS = 10_000;

export type StandbyHookKind = 'sleep' | 'wake';
type Runner = (cmd: string, timeoutMs: number) => Promise<string>;

/** Fire-and-forget; at most one run per kind in flight, output discarded. */
export function createStandbyHooks(
  dockIndex: number,
  settings: () => StandbySettings,
  run: Runner = runCommand,
): (kind: StandbyHookKind) => void {
  const inFlight = new Set<StandbyHookKind>();
  return function runHook(kind) {
    const s = settings();
    const cmd = kind === 'sleep' ? s.sleepCommand : s.wakeCommand;
    if (!cmd) return;
    const name = `${kind}Command`;
    if (inFlight.has(kind)) {
      log('debug', 'standby', `dock ${dockIndex}: ${name} still running, skipped`);
      return;
    }
    inFlight.add(kind);
    // An async wrapper turns a synchronous throw from `run` into a rejection.
    const launch = async (): Promise<string> => await run(cmd, STANDBY_COMMAND_TIMEOUT_MS);
    launch()
      .catch(function onFail(e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log('warn', 'standby', `dock ${dockIndex}: ${name} failed: ${msg}`);
      })
      .finally(function done() {
        inFlight.delete(kind);
      });
  };
}
