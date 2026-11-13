// Pure math of the device verify wizard: orientations, key order, size and blank
// ladders. Derivations: .claude/plans/2026-10-21_device-verify-wizard.md ("Math").
import type { VerifyOrientation, VerifyRotate } from '../../../contract-verify.js';

/** Image fields as transform.rs applies them: rotate CW, then flipH, then flipV. */
export type RawOrientation = VerifyOrientation & { flipV?: boolean };

const rot = (deg: number): VerifyRotate => (((deg % 360) + 360) % 360) as VerifyRotate;

/** flipV = flipH ∘ rotate 180, so it folds into the other two. */
export function canonical(o: RawOrientation): VerifyOrientation {
  return o.flipV
    ? { rotate: rot(o.rotate + 180), flipH: !o.flipH }
    : { rotate: o.rotate, flipH: o.flipH };
}

/** a ∘ b, b applied first. Uses flipH ∘ rotate r = rotate −r ∘ flipH. */
export function compose(a: RawOrientation, b: RawOrientation): VerifyOrientation {
  const x = canonical(a);
  const y = canonical(b);
  return {
    rotate: rot(y.flipH ? y.rotate - x.rotate : x.rotate + y.rotate),
    flipH: x.flipH !== y.flipH,
  };
}

/** Mirrored elements are their own inverse. */
export function invert(a: RawOrientation): VerifyOrientation {
  const x = canonical(a);
  return x.flipH ? x : { rotate: rot(-x.rotate), flipH: false };
}

export function sameOrientation(a: RawOrientation, b: RawOrientation): boolean {
  const x = canonical(a);
  const y = canonical(b);
  return x.rotate === y.rotate && x.flipH === y.flipH;
}

/** The 8 picture candidates of the orientation step. */
export const ORIENTATIONS: readonly VerifyOrientation[] = [false, true].flatMap((flipH) =>
  ([0, 90, 180, 270] as const).map((rotate) => ({ rotate, flipH })),
);

/** New image orientation T' = T ∘ P ∘ g⁻¹ ∘ P⁻¹, where g is what the deck shows for an
 *  upright tile sent as P(tile) through the current T. */
export function orientationFix(
  t: RawOrientation,
  p: RawOrientation,
  g: RawOrientation,
): VerifyOrientation {
  return compose(compose(t, p), compose(invert(g), invert(p)));
}

/** Splash sources are upright while app frames arrive as P(tile): S = T ∘ P. */
export function splashFor(
  t: RawOrientation,
  p: RawOrientation,
): VerifyOrientation & { flipV: false } {
  return { ...compose(t, p), flipV: false };
}

/** The splash to save (D12), or undefined when it stays as it is. Unpinned splash fields
 *  inherit from the image, so any image orientation change pins the derived splash. An
 *  unchanged image is no new evidence: keep the splash even where the derivation
 *  disagrees (AKP153E rev. 2, plan follow-up F1, not hardware-checked). */
export function splashToSave(
  image: RawOrientation,
  next: RawOrientation,
  p: RawOrientation,
): (VerifyOrientation & { flipV: false }) | undefined {
  const sameImage =
    image.rotate === next.rotate && image.flipH === next.flipH && !image.flipV === !next.flipV;
  return sameImage ? undefined : splashFor(next, p);
}

/** Canvas setTransform() arguments that draw an upright w×h tile as o(tile). */
export function orientMatrix(
  o: RawOrientation,
  w: number,
  h: number,
): [number, number, number, number, number, number] {
  const { rotate, flipH } = canonical(o);
  // Quarter turns only: cos and sin are table lookups.
  const cos = [1, 0, -1, 0][rotate / 90]!;
  const sin = [0, 1, 0, -1][rotate / 90]!;
  // Shift the rotated box back to the origin; flipH mirrors across the output width.
  const e = Math.max(0, -cos * w) + Math.max(0, sin * h);
  const f = Math.max(0, -sin * w) + Math.max(0, -cos * h);
  const m = flipH ? -1 : 1;
  const outWidth = rotate % 180 ? h : w;
  return [m * cos, sin, -m * sin, cos, flipH ? outWidth - e : e, f];
}

// --- Key order. σ[p] = number seen at CORA position p (0-based, row-major). ---

/** Candidate layouts, identity first, deduplicated, at most 6. */
export function orderCandidates(rows: number, columns: number): number[][] {
  const n = rows * columns;
  const at = (f: (r: number, c: number) => number): number[] =>
    Array.from({ length: n }, (_, p) => f(Math.floor(p / columns), p % columns));
  const list = [
    at((r, c) => r * columns + c),
    at((r, c) => (rows - 1 - r) * columns + c),
    at((r, c) => r * columns + columns - 1 - c),
    at((r, c) => (rows - 1 - r) * columns + columns - 1 - c),
    ...(rows === columns ? [at((r, c) => c * columns + r)] : []),
    at((r, c) => (r * columns + c + 1) % n),
    at((r, c) => (r * columns + c + n - 1) % n),
  ];
  const seen = new Set<string>();
  return list
    .filter((s) => {
      const k = s.join();
      return !seen.has(k) && !!seen.add(k);
    })
    .slice(0, 6);
}

/** inv[σ[p]] = p. Painting number inv[k] on CORA key k simulates σ (I1). */
export function invertOrder(sigma: readonly number[]): number[] {
  const inv: number[] = [];
  sigma.forEach((k, p) => (inv[k] = p));
  return inv;
}

/** p → base[σ[p]]: the corrected keyMap M' = M[σ], or σ ∘ σ2 for a re-pick made while
 *  σ was being simulated. */
export function applyOrder(base: readonly number[], sigma: readonly number[]): number[] {
  return sigma.map((i) => base[i] ?? -1);
}

/** Tap mode: pos[n] = cell tapped for number n, so σ[pos[n]] = n. Null until every cell
 *  is tapped exactly once. */
export function tapOrder(pos: readonly number[], count: number): number[] | null {
  const full =
    pos.length === count &&
    new Set(pos).size === count &&
    pos.every((v) => Number.isInteger(v) && v >= 0 && v < count);
  return full ? invertOrder(pos) : null;
}

// --- Size ladder (width = height). ---

const SIZES: readonly number[] = [64, 72, 80, 85, 90, 95, 96, 100, 112, 120];

/** cut = the outer ring is cut off (too big), gap = black gap outside it (too small). */
export type SizeAnswer = 'cut' | 'gap' | 'fits';

export interface SizeState {
  ladder: number[];
  /** The size to draft and show. */
  size: number;
  /** Smallest size answered 'cut' and largest answered 'gap': the panel size is between. */
  cut?: number;
  gap?: number;
  /** 'gap' = settled on the larger of the two sizes that still showed a gap. */
  result?: 'fits' | 'gap' | 'fail';
}

export function sizeStart(current: number): SizeState {
  return { ladder: [...new Set([...SIZES, current])].toSorted((a, b) => a - b), size: current };
}

export function sizeStep(s: SizeState, answer: SizeAnswer): SizeState {
  if (s.result) return s;
  if (answer === 'fits') return { ...s, result: 'fits' };
  const cut = answer === 'cut' ? Math.min(s.size, s.cut ?? Infinity) : s.cut;
  const gap = answer === 'gap' ? Math.max(s.size, s.gap ?? -Infinity) : s.gap;
  const next = { ...s, cut, gap };
  // Both answers seen = a reversal: bisect; at adjacency keep the gap (no content lost).
  if (cut !== undefined && gap !== undefined) {
    return cut - gap > 1
      ? { ...next, size: Math.floor((cut + gap) / 2) }
      : { ...next, size: gap, result: 'gap' };
  }
  const size =
    answer === 'cut' ? s.ladder.filter((v) => v < s.size).pop() : s.ladder.find((v) => v > s.size);
  if (size !== undefined) return { ...next, size };
  return { ...next, result: answer === 'cut' ? 'fail' : 'gap' };
}

// --- Blank ladder. ---

export interface BlankRung {
  maxBytes: number;
  quality: number;
}

export interface BlankState {
  /** Drafts to try in order; rungs[i] is the one shown now. */
  rungs: BlankRung[];
  i: number;
  /** 'fail' = still black at the last rung: a wire problem, not tunable. */
  result?: 'fixed' | 'fail';
}

/** Smaller JPEG caps first, then lower quality at the smallest cap. */
export function blankStart(image: BlankRung): BlankState {
  const uncapped = image.maxBytes === 0 || image.maxBytes === 0xffff;
  const caps = [10240, 8192, 5120, 4096].filter((b) => uncapped || b < image.maxBytes);
  const last = caps.at(-1) ?? image.maxBytes;
  const rungs = [
    ...caps.map((maxBytes) => ({ maxBytes, quality: image.quality })),
    ...[0.8, 0.7, 0.6]
      .filter((q) => q < image.quality)
      .map((quality) => ({ maxBytes: last, quality })),
  ];
  return rungs.length ? { rungs, i: 0 } : { rungs, i: 0, result: 'fail' };
}

export function blankStep(s: BlankState, visible: boolean): BlankState {
  if (s.result) return s;
  if (visible) return { ...s, result: 'fixed' };
  return s.i + 1 < s.rungs.length ? { ...s, i: s.i + 1 } : { ...s, result: 'fail' };
}
