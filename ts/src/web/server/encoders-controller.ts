// Rotary-encoder (knob) override for the SELECTED dock: connect the knobs to the
// Elgato app, or run a shell command per press / turn. Only honored while the
// strip is in a deckbridge-* mode — encoders.ts resolves it per dial event, so a
// change needs no app event, just persist + broadcast.
import { ENCODER_COMMAND_FIELDS } from '../../shared/encoder-settings.js';
import type { EncoderCommands, EncoderSettings } from '../../shared/types.js';
import type { ControllerHost, ReqError } from './types.js';

// Blank fields are dropped so an emptied knob doesn't persist as `{}`.
function trimCommands(c: EncoderCommands): EncoderCommands | undefined {
  const out: EncoderCommands = {};
  for (const f of ENCODER_COMMAND_FIELDS) {
    const cmd = c[f]?.trim();
    if (cmd) out[f] = cmd;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** `patch` over `base`: connectToApp replaces, each given knob replaces that knob. */
function mergeEncoders(base: EncoderSettings, patch: EncoderSettings): EncoderSettings {
  const commands = { ...base.commands };
  for (const [key, cmds] of Object.entries(patch.commands ?? {})) {
    const trimmed = trimCommands(cmds);
    if (trimmed) commands[key] = trimmed;
    else delete commands[key];
  }
  const connectToApp = patch.connectToApp ?? base.connectToApp;
  return {
    ...(connectToApp !== undefined ? { connectToApp } : {}),
    ...(Object.keys(commands).length > 0 ? { commands } : {}),
  };
}

export class EncodersController {
  constructor(private readonly host: ControllerHost) {}

  /** The SELECTED dock's encoder override (WebUI knob section). */
  selected(): EncoderSettings {
    return this.host.settings.for(this.host.selectedDeviceKey()).encoders() ?? {};
  }

  /** Merge `patch` into the SELECTED dock's settings, persist and broadcast. 409 when
   *  the dock has no strip or no knobs — the setting would mean nothing there. */
  trySet(patch: EncoderSettings): ReqError | null {
    const status = this.host.selectedDockStatus();
    const count = status?.encoderCount ?? 0;
    if (!status?.widgetDisplays?.length || count === 0) {
      return { error: 'selected dock has no rotary encoders', status: 409 };
    }
    const outOfRange = Object.keys(patch.commands ?? {}).find((k) => Number(k) >= count);
    if (outOfRange !== undefined) {
      return { error: `selected dock has no encoder ${outOfRange}`, status: 400 };
    }
    const next = mergeEncoders(this.selected(), patch);
    this.host.settings.for(this.host.selectedDeviceKey()).setEncoders(next);
    this.broadcastSelected();
    return null;
  }

  broadcastSelected(): void {
    this.host.broadcast('encoders', { encoders: this.selected() });
  }
}
