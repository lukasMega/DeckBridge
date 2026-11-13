// Saved Elgato pages (settings.json devices[].pages): the persisted shape, its bounds
// and guards. Hashes stay server-side, the WebUI only sees PageSummary.
import type { ExtraKeyConfig, PageSummary } from '../web/contract.js';
import { isExtraKeysRecord } from './extra-key-config.js';

export const MAX_PAGES = 32;
export const PAGE_NAME_MAX = 40;
export const PAGE_MIN_MATCH_DEFAULT = 0.8;
export const PAGE_MIN_MATCH_MIN = 0.5;

const PAGE_ID = /^p\d{1,6}$/;
const HASH = /^[0-9a-f]{8}$/;
const PROFILE_MAX = 64;
const KEY_COUNT_MAX = 64;

/** One saved Elgato page of one physical deck. */
export interface PageDefinition {
  /** 'p' + integer, unique within the device (nextPageId). */
  id: string;
  name: string;
  /** Advertised CORA model id when captured; a page of another profile never matches. */
  profile: string;
  /** Advertised key count when captured; hashes.length === keyCount. */
  keyCount: number;
  /** Frame hash per CORA key index (8 lowercase hex); null = no frame at capture. */
  hashes: (string | null)[];
  /** CORA key indices left out of matching (live, animated or blank keys). Sorted, unique. */
  ignore?: number[];
  /** Fraction of considered keys that must match. Absent = PAGE_MIN_MATCH_DEFAULT. */
  minMatch?: number;
  /** Own side-key/strip layout (same shape as devices[].extraKeys). Absent = default layout. */
  extraKeys?: Record<string, ExtraKeyConfig>;
}

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

export function pageNameError(v: unknown): string | null {
  if (typeof v !== 'string') return 'name must be a string';
  const n = v.trim().length;
  return n >= 1 && n <= PAGE_NAME_MAX ? null : `name must be 1–${PAGE_NAME_MAX} characters`;
}

/** null when `ignore` is a list of unique key indices below `keyCount`. */
export function pageIgnoreError(v: unknown, keyCount: number): string | null {
  if (
    !Array.isArray(v) ||
    !v.every((k) => isInt(k, 0, keyCount - 1)) ||
    new Set(v).size !== v.length
  ) {
    return `ignore must be unique key indices below ${keyCount}`;
  }
  return null;
}

export function pageMinMatchError(v: unknown): string | null {
  return typeof v === 'number' && v >= PAGE_MIN_MATCH_MIN && v <= 1
    ? null
    : `minMatch must be a number between ${PAGE_MIN_MATCH_MIN} and 1`;
}

const isHashList = (v: unknown, keyCount: number): boolean =>
  Array.isArray(v) &&
  v.length === keyCount &&
  v.every((h) => h === null || (typeof h === 'string' && HASH.test(h)));

/** The optional fields: absent, or well-formed. */
function hasValidOptionals(r: Record<string, unknown>, keyCount: number): boolean {
  return (
    (r.ignore === undefined || pageIgnoreError(r.ignore, keyCount) === null) &&
    (r.minMatch === undefined || pageMinMatchError(r.minMatch) === null) &&
    (r.extraKeys === undefined || isExtraKeysRecord(r.extraKeys))
  );
}

export function isPageDefinition(v: unknown): v is PageDefinition {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== 'string' || !PAGE_ID.test(r.id) || pageNameError(r.name)) return false;
  if (typeof r.profile !== 'string' || r.profile === '' || r.profile.length > PROFILE_MAX) {
    return false;
  }
  if (!isInt(r.keyCount, 1, KEY_COUNT_MAX) || !isHashList(r.hashes, r.keyCount)) return false;
  return hasValidOptionals(r, r.keyCount);
}

/** Keeps the valid entries of a persisted list (a bad hand-edit drops only itself),
 *  first duplicate id wins, capped at MAX_PAGES. Undefined when `v` is no array. */
export function sanitizePages(v: unknown): PageDefinition[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const seen = new Set<string>();
  const out: PageDefinition[] = [];
  for (const page of v) {
    if (!isPageDefinition(page) || seen.has(page.id)) continue;
    seen.add(page.id);
    out.push(page);
    if (out.length === MAX_PAGES) break;
  }
  return out;
}

export function nextPageId(pages: readonly PageDefinition[]): string {
  const max = pages.reduce((m, p) => Math.max(m, Number(p.id.slice(1))), 0);
  return `p${max + 1}`;
}

/** Keys a match uses: captured with an image, minus `ignore`. */
export function consideredKeys(page: PageDefinition): number[] {
  const ignored = new Set(page.ignore);
  return page.hashes.flatMap((h, i) => (h !== null && !ignored.has(i) ? [i] : []));
}

/** The config shown on `wireId`. A page with its own layout never falls back per key:
 *  a key it lacks shows nothing on that page. */
export function layoutConfigFor(
  page: PageDefinition | undefined,
  base: Record<string, ExtraKeyConfig>,
  wireId: number,
): ExtraKeyConfig | undefined {
  return (page?.extraKeys ?? base)[wireId];
}

/** Copy of `pages` with page `id`'s own layout replaced; undefined removes it. */
export function withPageLayout(
  pages: readonly PageDefinition[],
  id: string,
  extraKeys: Record<string, ExtraKeyConfig> | undefined,
): PageDefinition[] {
  return pages.map((p) => {
    if (p.id !== id) return p;
    const next = { ...p, extraKeys };
    if (!extraKeys) delete next.extraKeys;
    return next;
  });
}

export function toPageSummary(
  page: PageDefinition,
  currentProfile: string,
  currentKeyCount: number,
): PageSummary {
  const summary: PageSummary = {
    id: page.id,
    name: page.name,
    keyCount: page.keyCount,
    ignore: page.ignore ?? [],
    minMatch: page.minMatch ?? PAGE_MIN_MATCH_DEFAULT,
    considered: consideredKeys(page).length,
  };
  if (page.extraKeys) summary.extraKeys = page.extraKeys;
  if (page.profile !== currentProfile || page.keyCount !== currentKeyCount) summary.stale = true;
  return summary;
}
