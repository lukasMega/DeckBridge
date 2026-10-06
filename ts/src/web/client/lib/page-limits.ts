// Page limits the browser needs but may not import from shared/ (G1). The page-config test
// pins every value to its shared/page-config.ts twin.
export const MAX_PAGES = 32;
export const PAGE_NAME_MAX = 40;

/** Strict / Normal / Loose: the minMatch chips (Normal is PAGE_MIN_MATCH_DEFAULT). */
export const STRICTNESS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 1, label: 'Strict' },
  { value: 0.8, label: 'Normal' },
  { value: 0.6, label: 'Loose' },
];

/** The chip a free-form minMatch (hand-edited settings, API) is closest to. */
export function nearestStrictness(minMatch: number): number {
  let best = STRICTNESS[0]!.value;
  for (const { value } of STRICTNESS) {
    if (Math.abs(value - minMatch) < Math.abs(best - minMatch)) best = value;
  }
  return best;
}
