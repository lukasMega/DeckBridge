// Rotary-encoder override (AKP05/AKP05E knobs): while the touch strip is in a
// DeckBridge mode and the knobs are disconnected from the Elgato app, each knob
// runs its configured shell commands instead of reaching the app.
// SECURITY: arbitrary shell command from the WebUI config — same posture as the
// extra-key command widget (extra-keys.ts): loopback-only WebUI by default, but
// `--bind` on the LAN lets anyone reaching :3000 run a command on this host.
// Opt-in per knob, trusted personal LAN only.
import { COMMAND_TIMEOUT_DEFAULT_MS } from './types.js';
import type { DialEvent, EncoderCommands, EncoderSettings, TouchStripMode } from './types.js';
import { runCommand } from './os-utils.js';
import { log } from './logger.js';

/** One dock's strip mode + encoder settings, resolved per event. */
export interface EncoderOverride {
  mode: TouchStripMode;
  encoders?: EncoderSettings;
}

export type CommandRunner = (cmd: string, timeoutMs: number) => Promise<string>;

type EncoderAction = keyof EncoderCommands;

function actionFor(event: DialEvent): EncoderAction | null {
  if (event.kind === 'press') return event.state === 'down' ? 'press' : null;
  if (event.delta > 0) return 'rotateCw';
  return event.delta < 0 ? 'rotateCcw' : null;
}

/** Intercepts one dock's dial events and runs the knob commands. */
export class EncoderActions {
  private readonly settingsFor: () => EncoderOverride | undefined;
  private readonly run: CommandRunner;
  /** Keyed `${index}:${action}`; `pending` = more detents arrived while running. */
  private readonly inflight = new Map<string, { pending: boolean }>();

  constructor(settingsFor: () => EncoderOverride | undefined, run: CommandRunner = runCommand) {
    this.settingsFor = settingsFor;
    this.run = run;
  }

  /** True when the event is consumed — the caller must not forward it to the app.
   *  A disconnected knob is always consumed, even with no command set. */
  handleDial(event: DialEvent): boolean {
    if (!this.disconnected(this.settingsFor())) return false;
    // A press 'up' (the AKP05 driver synthesizes it) is swallowed: the command runs on 'down'.
    const action = actionFor(event);
    if (action) this.trigger(event.index, action);
    return true;
  }

  private disconnected(settings: EncoderOverride | undefined): settings is EncoderOverride {
    return !!settings && settings.mode !== 'elgato' && settings.encoders?.connectToApp === false;
  }

  /** Re-resolved per run, so a coalesced re-run honours a config change made meanwhile. */
  private commandFor(index: number, action: EncoderAction): string | undefined {
    const settings = this.settingsFor();
    if (!this.disconnected(settings)) return undefined;
    return settings.encoders?.commands?.[String(index)]?.[action]?.trim() || undefined;
  }

  /** At most one process per (knob, action): a fast spin coalesces into one
   *  follow-up run instead of flooding the shell with one process per detent. */
  private trigger(index: number, action: EncoderAction): void {
    const key = `${index}:${action}`;
    const running = this.inflight.get(key);
    if (running) {
      running.pending = true;
      return;
    }
    const cmd = this.commandFor(index, action);
    if (!cmd) return;
    const entry = { pending: false };
    this.inflight.set(key, entry);
    log('debug', 'encoder', `knob ${index} ${action}: ${cmd}`);
    // runCommand kills the process after the timeout, so a hung command can't pin the slot.
    void this.run(cmd, COMMAND_TIMEOUT_DEFAULT_MS)
      .catch((e: unknown) => {
        log('warn', 'encoder', `knob ${index} ${action} failed: ${(e as Error).message}`);
      })
      .finally(() => {
        this.inflight.delete(key);
        if (entry.pending) this.trigger(index, action);
      });
  }
}
