// Pure page fingerprint matching: which saved Elgato page do the key frames on the deck
// show now? The tracker (main/page-tracker.ts) owns timing, this owns the scoring.
import type { PageScoreMsg } from '../web/contract.js';
import { consideredKeys, PAGE_MIN_MATCH_DEFAULT } from './page-config.js';
import type { PageDefinition } from './page-config.js';

/** Quiet time after the last non-animated frame before a page is evaluated. */
export const PAGE_SETTLE_MS = 150;
/** Evaluate at least this often while frames keep flowing. */
export const PAGE_MAX_WAIT_MS = 600;
/** Two frames on one key closer than this mean the key is animated. */
export const PAGE_ANIMATED_GAP_MS = 400;
/** Fewer distinct frame hashes than this hold the layout (no app, blank transition). */
export const PAGE_HOLD_MIN_DISTINCT = 2;

export type PageScore = PageScoreMsg;

/** What the tracker tells the WebUI about the current deck contents. */
export interface PageObservation {
  profile: string;
  keyCount: number;
  columns: number;
  /** Latest frame hash per CORA key (null = none since reset). */
  hashes: readonly (string | null)[];
  activePageId: string | null;
  scores: PageScore[];
  suggestedIgnore: number[];
  settling: boolean;
  held: boolean;
}

export type FrameHashes = readonly (string | null)[];

/** Matches needed out of `considered` keys; the epsilon keeps 5 × 0.6 at 3. */
export function requiredMatches(considered: number, minMatch: number): number {
  return Math.max(1, Math.ceil(considered * minMatch - 1e-9));
}

export function scorePage(page: PageDefinition, current: FrameHashes): PageScore {
  const considered = consideredKeys(page);
  const mismatched = considered.filter((k) => current[k] !== page.hashes[k]);
  return {
    pageId: page.id,
    matched: considered.length - mismatched.length,
    considered: considered.length,
    mismatched,
  };
}

export function isEligible(page: PageDefinition, profile: string, keyCount: number): boolean {
  return page.profile === profile && page.keyCount === keyCount && consideredKeys(page).length > 0;
}

/** Eligible pages scored, best first: ratio, then more considered keys, then list order. */
export function rankPages(
  pages: readonly PageDefinition[],
  current: FrameHashes,
  profile: string,
  keyCount: number,
): PageScore[] {
  return pages
    .filter((p) => isEligible(p, profile, keyCount))
    .map((p) => scorePage(p, current))
    .toSorted(
      (a, b) => b.matched * a.considered - a.matched * b.considered || b.considered - a.considered,
    );
}

/** The best-ranked page that passes its own threshold. */
export function pickWinner(
  scores: readonly PageScore[],
  pages: readonly PageDefinition[],
): PageScore | undefined {
  return scores.find((s) => {
    const page = pages.find((p) => p.id === s.pageId);
    return (
      page !== undefined &&
      s.matched >= requiredMatches(s.considered, page.minMatch ?? PAGE_MIN_MATCH_DEFAULT)
    );
  });
}

export function isHeldVector(current: FrameHashes): boolean {
  return new Set(current.filter((h) => h !== null)).size < PAGE_HOLD_MIN_DISTINCT;
}

/** Keys a snapshot should ignore by default: animated ones plus keys sharing an image
 *  (the app's blank key). Animated only when that would leave nothing to match. */
export function suggestIgnore(current: FrameHashes, animated: ReadonlySet<number>): number[] {
  const counts = new Map<string, number>();
  for (const h of current) if (h !== null) counts.set(h, (counts.get(h) ?? 0) + 1);
  const duplicates = current.flatMap((h, i) => (h !== null && counts.get(h)! >= 2 ? [i] : []));
  const withDuplicates = [...new Set([...duplicates, ...animated])].toSorted((a, b) => a - b);
  const left = current.filter((h, i) => h !== null && !withDuplicates.includes(i)).length;
  return left > 0 ? withDuplicates : [...animated].toSorted((a, b) => a - b);
}
