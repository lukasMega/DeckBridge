// Shell-command actions bound to physical controls DeckBridge owns: the AKP05 knobs
// (encoders.ts) and pressable extra keys (AKP05E's right column while re-paired as a
// Stream Deck +, which the Plus grid drops).
// SECURITY: arbitrary shell command from the WebUI config — same posture as the
// extra-key command widget (extra-keys.ts): loopback-only WebUI by default, but
// `--bind` on the LAN lets anyone reaching :3000 run a command on this host.
// Opt-in per control, trusted personal LAN only.
import { COMMAND_TIMEOUT_DEFAULT_MS, effectivePressAction } from '../shared/types.js';
import type { ExtraKeyConfig, KeyState } from '../shared/types.js';
import { runCommand } from '../infra/command-runner.js';
import { log } from '../shared/logger.js';

export type CommandRunner = (cmd: string, timeoutMs: number) => Promise<string>;

/** At most one process per slot: a burst (fast knob spin, key mashing) coalesces
 *  into one follow-up run instead of flooding the shell with one process per event. */
export class CommandSlots {
  private readonly component: string;
  private readonly run: CommandRunner;
  /** `pending` = more events arrived while running. */
  private readonly inflight = new Map<string, { pending: boolean }>();
  private stopped = false;

  constructor(component: string, run: CommandRunner) {
    this.component = component;
    this.run = run;
  }

  /** `commandFor` is re-resolved per run, so a coalesced re-run honours a config
   *  change made meanwhile; undefined = nothing to run. */
  trigger(slot: string, commandFor: () => string | undefined): void {
    if (this.stopped) return;
    const running = this.inflight.get(slot);
    if (running) {
      running.pending = true;
      return;
    }
    const cmd = commandFor();
    if (!cmd) return;
    const entry = { pending: false };
    this.inflight.set(slot, entry);
    log('debug', this.component, `${slot}: ${cmd}`);
    // runCommand kills the process after the timeout, so a hung command can't pin the slot.
    void this.run(cmd, COMMAND_TIMEOUT_DEFAULT_MS)
      .catch((e: unknown) => {
        log('warn', this.component, `${slot} failed: ${(e as Error).message}`);
      })
      .finally(() => {
        this.inflight.delete(slot);
        if (entry.pending) this.trigger(slot, commandFor);
      });
  }

  /** Terminal: no new runs and no coalesced follow-ups. Running commands are cancelled
   *  by the runner's own shutdown (command-runner stopCommands). */
  stop(): void {
    this.stopped = true;
    for (const entry of this.inflight.values()) entry.pending = false;
  }
}

/** Runs one dock's extra-key presses: the press command (ExtraKeyConfig.pressCommand)
 *  and/or a refresh of the key's widget, per ExtraKeyConfig.pressAction. */
export class ExtraKeyActions {
  private readonly configFor: (wireId: number) => ExtraKeyConfig | undefined;
  private readonly slots: CommandSlots;
  private readonly refresh: (wireId: number) => void;

  constructor(
    configFor: (wireId: number) => ExtraKeyConfig | undefined,
    run: CommandRunner = runCommand,
    /** Tap refresh of the key's widget (ExtraKeyWidgets.refresh, via the dock). */
    refresh: (wireId: number) => void = () => undefined,
  ) {
    this.configFor = configFor;
    this.slots = new CommandSlots('extra-key', run);
    this.refresh = refresh;
  }

  stop(): void {
    this.slots.stop();
  }

  handleKey(wireId: number, state: KeyState): void {
    if (state !== 'down') return;
    const action = effectivePressAction(this.configFor(wireId));
    if (action !== 'command') this.refresh(wireId);
    if (action === 'refresh') return;
    this.slots.trigger(
      `key ${wireId} press`,
      () => this.configFor(wireId)?.pressCommand?.trim() || undefined,
    );
  }
}
