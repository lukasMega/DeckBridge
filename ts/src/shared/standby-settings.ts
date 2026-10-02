// Per-device standby / burn-in care settings: defaults, validation, resolution.
// Pure; used by the settings loader, the WebUI route and main/dock-standby.ts.
import type { StandbySettings } from '../web/contract-standby.js';

export const DEFAULT_STANDBY: Readonly<StandbySettings> = {
  idleDim: false,
  idleMinutes: 5,
  idleLevel: 10,
  offWhenIdle: false,
  offMinutes: 30,
  offMode: 'auto',
  wakePress: 'swallow',
  appGoneAction: 'none',
  clockLevel: 20,
  night: false,
  nightStart: '23:00',
  nightEnd: '07:00',
  nightLevel: 10,
  nightOffWhenIdle: true,
  pixelShift: false,
};

export const STANDBY_IDLE_MINUTES = { min: 1, max: 240 } as const;
export const STANDBY_OFF_MINUTES = { min: 1, max: 1440 } as const;
export const STANDBY_COMMAND_MAX = 1024;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 'HH:MM' → minute of day, or undefined when malformed. */
export function parseHhmm(v: unknown): number | undefined {
  const m = typeof v === 'string' ? HHMM.exec(v) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
}

export function formatHhmm(minuteOfDay: number): string {
  const h = Math.floor(minuteOfDay / 60);
  const m = minuteOfDay % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

type Check = (v: unknown) => string | null;

const bool: Check = (v) => (typeof v === 'boolean' ? null : 'must be a boolean');
const intIn =
  (min: number, max: number): Check =>
  (v) =>
    Number.isInteger(v) && (v as number) >= min && (v as number) <= max
      ? null
      : `must be an integer ${min}..${max}`;
const oneOf =
  (allowed: readonly string[]): Check =>
  (v) =>
    allowed.includes(v as string) ? null : `must be one of: ${allowed.join(', ')}`;
const hhmm: Check = (v) => (parseHhmm(v) === undefined ? "must be 'HH:MM' (00:00..23:59)" : null);
const command: Check = (v) =>
  typeof v === 'string' && v.length > 0 && v.length <= STANDBY_COMMAND_MAX
    ? null
    : `must be a non-empty string of at most ${STANDBY_COMMAND_MAX} characters`;

const CHECKS: ReadonlyArray<readonly [keyof StandbySettings, Check]> = [
  ['idleDim', bool],
  ['idleMinutes', intIn(STANDBY_IDLE_MINUTES.min, STANDBY_IDLE_MINUTES.max)],
  ['idleLevel', intIn(1, 100)],
  ['offWhenIdle', bool],
  ['offMinutes', intIn(STANDBY_OFF_MINUTES.min, STANDBY_OFF_MINUTES.max)],
  ['offMode', oneOf(['auto', 'brightness0'])],
  ['wakePress', oneOf(['swallow', 'forward'])],
  ['appGoneAction', oneOf(['none', 'clock', 'off'])],
  ['clockLevel', intIn(1, 100)],
  ['night', bool],
  ['nightStart', hhmm],
  ['nightEnd', hhmm],
  ['nightLevel', intIn(1, 100)],
  ['nightOffWhenIdle', bool],
  ['pixelShift', bool],
  ['sleepCommand', command],
  ['wakeCommand', command],
];

/** Persisted partial (possibly with unknown keys) → full settings over DEFAULT_STANDBY. */
export function resolveStandby(partial: Partial<StandbySettings> | undefined): StandbySettings {
  const out: StandbySettings = { ...DEFAULT_STANDBY };
  if (!partial) return out;
  const src = partial as Record<string, unknown>;
  const dst = out as unknown as Record<string, unknown>;
  for (const [key] of CHECKS) if (src[key] !== undefined) dst[key] = src[key];
  return out;
}

/** null = valid. Checks only present keys, ignores unknown keys, and rejects
 *  cross-field conflicts after resolving defaults. */
export function standbySettingsError(v: unknown): string | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return 'standby must be an object';
  }
  const r = v as Record<string, unknown>;
  for (const [key, check] of CHECKS) {
    const err = r[key] === undefined ? null : check(r[key]);
    if (err) return `${key} ${err}`;
  }
  const s = resolveStandby(r);
  if (s.nightStart === s.nightEnd) return 'nightStart and nightEnd must differ';
  if (s.idleDim && s.offWhenIdle && s.offMinutes <= s.idleMinutes) {
    return 'offMinutes must be greater than idleMinutes';
  }
  return null;
}

/** Keep only known WebUI keys (what the POST handler persists). Never sleepCommand /
 *  wakeCommand: those are settings.json-only. */
export function pickStandbyKeys(v: Record<string, unknown>): Partial<StandbySettings> {
  const out: Record<string, unknown> = {};
  for (const [key] of CHECKS) {
    if (key === 'sleepCommand' || key === 'wakeCommand') continue;
    if (v[key] !== undefined) out[key] = v[key];
  }
  return out;
}

/** StandbyView.settings: resolved settings without the command keys. */
export function publicStandby(
  s: StandbySettings,
): Omit<StandbySettings, 'sleepCommand' | 'wakeCommand'> {
  const rest: StandbySettings = { ...s };
  delete rest.sleepCommand;
  delete rest.wakeCommand;
  return rest;
}
