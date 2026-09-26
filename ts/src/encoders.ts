// Rotary-encoder override (AKP05/AKP05E knobs): while the touch strip is in a
// DeckBridge mode and the knobs are disconnected from the Elgato app, each knob
// runs its configured shell commands instead of reaching the app.
// SECURITY: see command-actions.ts — opt-in per knob, trusted personal LAN only.
import type { DialEvent, EncoderCommands, EncoderSettings, TouchStripMode } from './types.js';
import { runCommand } from './os-utils.js';
import { CommandSlots, type CommandRunner } from './command-actions.js';

/** One dock's strip mode + encoder settings, resolved per event. */
export interface EncoderOverride {
  mode: TouchStripMode;
  encoders?: EncoderSettings;
}

type EncoderAction = keyof EncoderCommands;

function actionFor(event: DialEvent): EncoderAction | null {
  if (event.kind === 'press') return event.state === 'down' ? 'press' : null;
  if (event.delta > 0) return 'rotateCw';
  return event.delta < 0 ? 'rotateCcw' : null;
}

/** Intercepts one dock's dial events and runs the knob commands. */
export class EncoderActions {
  private readonly settingsFor: () => EncoderOverride | undefined;
  private readonly slots: CommandSlots;
  private readonly refreshZone: (index: number) => void;

  constructor(
    settingsFor: () => EncoderOverride | undefined,
    run: CommandRunner = runCommand,
    /** Tap refresh of the strip zone above knob `index` (the dock maps it to a wire id). */
    refreshZone: (index: number) => void = () => undefined,
  ) {
    this.settingsFor = settingsFor;
    this.slots = new CommandSlots('encoder', run);
    this.refreshZone = refreshZone;
  }

  /** True when the event is consumed — the caller must not forward it to the app.
   *  A disconnected knob is always consumed, even with no command set; a press with
   *  no command refreshes the widget above the knob. */
  handleDial(event: DialEvent): boolean {
    if (!this.disconnected(this.settingsFor())) return false;
    // A press 'up' (the AKP05 driver synthesizes it) is swallowed: the command runs on 'down'.
    const action = actionFor(event);
    if (action === 'press' && !this.commandFor(event.index, 'press')) {
      this.refreshZone(event.index);
    } else if (action) {
      this.trigger(event.index, action);
    }
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

  private trigger(index: number, action: EncoderAction): void {
    this.slots.trigger(`knob ${index} ${action}`, () => this.commandFor(index, action));
  }
}
