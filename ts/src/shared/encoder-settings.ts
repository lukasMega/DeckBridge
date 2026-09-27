// Shape check for a knob override, shared by the WebUI POST body and the
// settings.json guard (infra/settings.ts).
import { ENCODER_COMMAND_MAX } from './extra-key-config.js';

export const ENCODER_COMMAND_FIELDS = ['press', 'rotateCw', 'rotateCcw'] as const;
const ENCODER_INDEX = /^[0-3]$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function commandsError(key: string, v: unknown): string | null {
  if (!ENCODER_INDEX.test(key)) return `commands key '${key}' must be an encoder index 0-3`;
  if (!isRecord(v)) return `commands['${key}'] must be an object`;
  for (const f of ENCODER_COMMAND_FIELDS) {
    const c = v[f];
    if (c !== undefined && (typeof c !== 'string' || c.length > ENCODER_COMMAND_MAX)) {
      return `commands['${key}'].${f} must be a string ≤ ${ENCODER_COMMAND_MAX} chars`;
    }
  }
  return null;
}

/** null = valid. */
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
