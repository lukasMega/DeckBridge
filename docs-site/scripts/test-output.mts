// Layer 4 — output sanity.
//
// A tripwire for shape regressions in generated output, NOT a security proof.
// Note what is deliberately absent: an "unescaped </script>" check is not
// expressible as a regex (an unescaped </script> *is* the terminator, so the
// parser can no longer tell it from a correct one), and scanning for "eval() of
// user content" is not decidable from the built artifact. What remains is cheap
// and real.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  BUILD_DIR,
  allRoutes,
  extractAttrs,
  inlineScripts,
  jsonLdBlocks,
  readPage,
  readSitemap,
  requireBuild,
  sitemapUrls,
} from './lib.mts';

requireBuild();

test('inline script count per page stays within the expected range', () => {
  // Docusaurus emits the color-mode init and (on most routes) the baseUrl issue
  // banner. If this count moves, something started injecting scripts — look.
  for (const route of allRoutes()) {
    const count = inlineScripts(readPage(route)).length;
    assert.ok(
      count >= 1 && count <= 3,
      `route '${route || '/'}' has ${count} inline scripts, expected 1-3`,
    );
  }
});

test('every inline script is syntactically valid JavaScript', () => {
  // Compiled, never executed — a truncated or badly escaped inline script
  // (the classic serialization regression) fails to parse here.
  for (const route of allRoutes()) {
    for (const [i, body] of inlineScripts(readPage(route)).entries()) {
      assert.doesNotThrow(
        () => new Function(body),
        `inline script #${i} on route '${route || '/'}' does not parse`,
      );
    }
  }
});

test('no javascript: URLs or inline event handlers in the output', () => {
  for (const route of allRoutes()) {
    const html = readPage(route);
    const where = route || '/';

    const jsHrefs = extractAttrs(html, 'href').filter((h) => /^javascript:/i.test(h.trim()));
    assert.deepEqual(jsHrefs, [], `javascript: URLs on '${where}'`);

    // Match on* handlers only in tag position, so prose containing "online"
    // or a JS property assignment inside an inline script does not trip it.
    const handlers = html.match(/<[a-z][^>]*?\son(?:click|error|load|mouseover)=/gi);
    assert.equal(handlers, null, `inline event handlers on '${where}'`);
  }
});

test('JSON-LD structured data parses', () => {
  // Emitted on doc pages as a BreadcrumbList. Not JavaScript, so it gets a JSON
  // parser rather than the JS one above.
  let checked = 0;
  for (const route of allRoutes()) {
    for (const body of jsonLdBlocks(readPage(route))) {
      checked++;
      assert.doesNotThrow(() => JSON.parse(body), `invalid JSON-LD on route '${route || '/'}'`);
    }
  }
  assert.ok(checked > 0, 'no JSON-LD blocks found — structured data regressed');
});

test('search index has the expected top-level shape', () => {
  const raw = readFileSync(join(BUILD_DIR, 'search-index.json'), 'utf8');
  const parsed: unknown = JSON.parse(raw);

  assert.ok(Array.isArray(parsed), 'search-index.json is not an array');
  assert.ok(parsed.length > 0, 'search index is empty');
  for (const entry of parsed) {
    assert.ok(entry !== null && typeof entry === 'object', 'search index entry is not an object');
  }
});

test('sitemap.xml is well-formed', () => {
  const xml = readSitemap();

  assert.match(xml, /^<\?xml/, 'sitemap does not start with an XML declaration');
  assert.equal(
    (xml.match(/<urlset[\s>]/g) ?? []).length,
    1,
    'sitemap must have exactly one <urlset> root',
  );
  assert.equal(
    (xml.match(/<url>/g) ?? []).length,
    (xml.match(/<\/url>/g) ?? []).length,
    'unbalanced <url> tags',
  );
  assert.equal(
    (xml.match(/<loc>/g) ?? []).length,
    (xml.match(/<\/loc>/g) ?? []).length,
    'unbalanced <loc> tags',
  );

  for (const url of sitemapUrls()) {
    assert.doesNotThrow(() => new URL(url), `invalid sitemap URL: ${url}`);
  }
});
