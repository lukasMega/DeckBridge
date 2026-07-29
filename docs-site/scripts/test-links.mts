// Layer 2 — link integrity across the built HTML.
//
// Docusaurus already validates markdown-level doc links (onBrokenLinks: 'throw'),
// so this layer covers what it does not: rendered-HTML links, asset paths, and
// heading-anchor targets. External links are deliberately not fetched.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { test } from 'node:test';

import {
  BUILD_DIR,
  EXPECTED_BASE_URL,
  allRoutes,
  extractAttrs,
  isExternal,
  pageFile,
  readPage,
  requireBuild,
  resolveHref,
} from './lib.mts';

requireBuild();

const routes = allRoutes();

/** id="..." values per built file, cached — several pages link to the same target. */
const idCache = new Map<string, Set<string>>();
function idsOf(file: string): Set<string> {
  let ids = idCache.get(file);
  if (!ids) {
    ids = new Set(extractAttrs(readFileSync(file, 'utf8'), 'id'));
    idCache.set(file, ids);
  }
  return ids;
}

interface Link {
  href: string;
  from: string;
}

/** Every href + img/src on a page, paired with the page it came from. */
function linksOf(route: string): Link[] {
  const html = readPage(route);
  return [...extractAttrs(html, 'href'), ...extractAttrs(html, 'src')].map((href) => ({
    href,
    from: route || '/',
  }));
}

// Only read pages that exist, so a missing page surfaces as the named assertion
// below rather than an ENOENT thrown while this module is still loading.
const missingPages = routes.filter((route) => !existsSync(pageFile(route)));
const allLinks: Link[] = routes.filter((route) => existsSync(pageFile(route))).flatMap(linksOf);

test('every route in the sitemap has a built page', () => {
  assert.deepEqual(missingPages, [], 'sitemap lists routes with no built HTML');
});

test('link extraction actually finds links', () => {
  // The tripwire for G1: the build output is minified with unquoted attributes,
  // so a naive `href="..."` regex silently matches nothing and every assertion
  // below would vacuously pass. Fail loudly instead.
  assert.ok(
    allLinks.length > 100,
    `only ${allLinks.length} links extracted across ${routes.length} pages — attribute extraction is probably broken (see G1)`,
  );

  for (const route of routes) {
    assert.ok(linksOf(route).length > 0, `no links extracted from route '${route || '/'}'`);
  }
});

test('internal links carry the baseUrl prefix', () => {
  // A root-relative link like /features works in dev but 404s on GitHub Pages,
  // where the site is served under /DeckBridge/.
  const bad = allLinks
    .filter(({ href }) => resolveHref(href)?.bad)
    .map(({ from, href }) => `${from} -> ${href}`);

  assert.deepEqual(bad, [], `internal links missing the '${EXPECTED_BASE_URL}' prefix`);
});

test('every internal link resolves to a file in build/', () => {
  const missing: string[] = [];

  for (const { href, from } of allLinks) {
    const res = resolveHref(href);
    if (!res || res.bad || !res.file) continue;
    if (!existsSync(res.file)) {
      missing.push(`${from} -> ${href} (expected ${relative(BUILD_DIR, res.file)})`);
    }
  }

  assert.deepEqual(missing, [], 'dead internal links');
});

test('every anchor target exists on the page it points at', () => {
  const missing: string[] = [];
  let checked = 0;

  for (const { href, from } of allLinks) {
    if (isExternal(href)) continue;

    const hash = href.indexOf('#');
    if (hash < 0) continue;
    const frag = href.slice(hash + 1);
    if (!frag) continue;

    const target = href.slice(0, hash);
    // Same-page anchor, or a cross-page one that must resolve first.
    let file: string;
    if (target === '' || target === '.') {
      file = pageFile(from === '/' ? '' : from);
    } else {
      const res = resolveHref(href);
      if (!res || res.bad || !res.file || !existsSync(res.file)) continue; // covered above
      file = res.file;
    }

    checked++;
    if (!idsOf(file).has(frag)) missing.push(`${from} -> ${href}`);
  }

  assert.ok(checked > 50, `only ${checked} anchors checked — extraction may be broken`);
  assert.deepEqual(missing, [], 'anchor links pointing at ids that do not exist');
});
