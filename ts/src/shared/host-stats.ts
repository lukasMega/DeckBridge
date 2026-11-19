// Host CPU / memory / GPU figures for the Ulanzi D200 info window's stats mode: the value
// type, the 0-100 clamp every hop applies, and the plugin override's JSON. Pure, no I/O.

/** Whole percents 0-100, the range the firmware's stats fields take. */
export interface HostStats {
  cpu: number;
  mem: number;
  gpu: number;
}

export const NO_STATS: Readonly<HostStats> = { cpu: 0, mem: 0, gpu: 0 };

const STAT_KEYS = ['cpu', 'mem', 'gpu'] as const;

/** Round into 0-100; anything not finite is 0. */
export function clampPercent(n: number): number {
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 0;
}

export function sameStats(a: HostStats, b: HostStats): boolean {
  return a.cpu === b.cpu && a.mem === b.mem && a.gpu === b.gpu;
}

/** A stats plugin's reply, JSON `{"cpu":12,"mem":34,"gpu":56}`, laid over `builtin`: each key
 *  it gives replaces the built-in value (GPU included), a key it omits keeps it. Null when
 *  the text is not that shape, so the caller falls back to the built-in values whole. */
export function applyPluginStats(raw: string, builtin: HostStats): HostStats | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const given = parsed as Record<string, unknown>;
  const out = { ...builtin };
  let any = false;
  for (const key of STAT_KEYS) {
    const v = given[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    out[key] = clampPercent(v);
    any = true;
  }
  return any ? out : null;
}
