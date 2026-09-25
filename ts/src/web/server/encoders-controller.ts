// Rotary-encoder (knob) override for the SELECTED dock: connect the knobs to the
// Elgato app, or run a shell command per press / turn. Only honored while the
// strip is in a deckbridge-* mode — encoders.ts resolves it per dial event, so a
// change needs no app event, just persist + broadcast.
import { ENCODER_COMMAND_MAX } from '../../types.js';
import type { EncoderCommands, EncoderSettings } from '../../types.js';
import type { ControllerHost, ReqError } from './types.js';

const COMMAND_FIELDS = ['press', 'rotateCw', 'rotateCcw'] as const;
const ENCODER_INDEX = /^[0-3]$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function commandsError(key: string, v: unknown): string | null {
  if (!ENCODER_INDEX.test(key)) return `commands key '${key}' must be an encoder index 0-3`;
  if (!isRecord(v)) return `commands['${key}'] must be an object`;
  for (const f of COMMAND_FIELDS) {
    const c = v[f];
    if (c !== undefined && (typeof c !== 'string' || c.length > ENCODER_COMMAND_MAX)) {
      return `commands['${key}'].${f} must be a string ≤ ${ENCODER_COMMAND_MAX} chars`;
    }
  }
  return null;
}

/** Shape check shared by the POST body and the settings.json guard; null = valid. */
export function encoderSettingsError(v: unknown): string | null {
  if (!isRecord(v)) return 'encoders must be an object';
  if (v.connectToApp !== undefined && typeof v.connectToApp !== 'boolean') {
    return 'connectToApp must be a boolean';
  }
  if (v.commands === undefined) return null;
  if (!isRecord(v.commands)) return 'commands must be an object';
  for (const [key, cmds] of Object.entries(v.commands)) {
    const err = commandsError(key, cmds);
    if (err) return err;
  }
  return null;
}

// Blank fields are dropped so an emptied knob doesn't persist as `{}`.
function trimCommands(c: EncoderCommands): EncoderCommands | undefined {
  const out: EncoderCommands = {};
  for (const f of COMMAND_FIELDS) {
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
  // No deviceKey yet (before the first connect): runtime-only, never persisted.
  private runtimeEncoders: EncoderSettings = {};

  constructor(private readonly host: ControllerHost) {}

  /** Per-device encoder override — read per dial event by DriverManager/DeviceSession. */
  settingsFor(deviceKey: string): EncoderSettings | undefined {
    const e = this.host.settings.entryFor(deviceKey);
    return e ? e.encoders : this.runtimeEncoders;
  }

  /** The SELECTED dock's encoder override (WebUI knob section). */
  selected(): EncoderSettings {
    return this.settingsFor(this.host.selectedDeviceKey()) ?? {};
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
    const e = this.host.settings.entryFor(this.host.selectedDeviceKey());
    if (e) {
      if (Object.keys(next).length > 0) e.encoders = next;
      else delete e.encoders;
      this.host.settings.persist();
    } else {
      this.runtimeEncoders = next;
    }
    this.broadcastSelected();
    return null;
  }

  broadcastSelected(): void {
    this.host.broadcast('encoders', { encoders: this.selected() });
  }
}
