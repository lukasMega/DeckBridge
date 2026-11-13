// Saved-page fixtures shared by the page-following suites (not a *.test.ts).
import type { PageDefinition } from '../../src/shared/page-config.js';

/** 8-hex frame hash for `seed` (lowercase, deterministic). */
export const hashOf = (seed: string | number): string =>
  Array.from(String(seed))
    .reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7)
    .toString(16)
    .padStart(8, '0');

/** `count` distinct hashes for one fake page: `<tag>-<key>`. */
export const pageHashes = (tag: string, count = 15): string[] =>
  Array.from({ length: count }, (_, i) => hashOf(`${tag}-${i}`));

export function makePage(
  id: string,
  tag: string,
  extra: Partial<PageDefinition> = {},
): PageDefinition {
  return {
    id,
    name: `Page ${tag}`,
    profile: 'mk2',
    keyCount: 15,
    hashes: pageHashes(tag),
    ...extra,
  };
}
