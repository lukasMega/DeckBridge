// Layer 3 — content integrity.
//
// Presence checks only, by design. Heading text comes from two different sources
// (frontmatter `title:` on 5 docs, a leading `# heading` on the other 6) and is
// HTML-entity-escaped in the output, so exact text matching would be a
// false-failure generator. CSS-module class names are content-hashed
// (sectionTitle_Ut5p) and must not be asserted on either.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DOC_ROUTES, allRoutes, extractAttrs, readPage, requireBuild } from './lib.mts';

requireBuild();

/** Pages whose markdown contains ```mermaid fences. */
const MERMAID_ROUTES: readonly string[] = ['image-flow', 'hidapi-ffi', 'features', 'ARCHITECTURE'];

test('every doc page has exactly one h1', () => {
  for (const route of DOC_ROUTES) {
    const count = (readPage(route).match(/<h1[\s>]/g) ?? []).length;
    assert.equal(count, 1, `route '${route}' has ${count} h1 elements, expected 1`);
  }
});

test('navbar, footer and search box render on every route', () => {
  for (const route of allRoutes()) {
    const html = readPage(route);
    const where = route || '/';
    assert.match(html, /navbar__title/, `navbar missing on '${where}'`);
    assert.match(html, /footer__links/, `footer missing on '${where}'`);
    assert.match(html, /aria-label="?Search/, `search box missing on '${where}'`);
  }
});

test('footer keeps its GitHub and Privacy links', () => {
  const hrefs = extractAttrs(readPage('introduction'), 'href');
  assert.ok(
    hrefs.some((h) => h.includes('github.com/lukasMega/DeckBridge')),
    'footer GitHub link missing',
  );
  assert.ok(
    hrefs.some((h) => h.endsWith('/privacy')),
    'footer Privacy link missing',
  );
});

test('prism highlights code fences', () => {
  assert.match(
    readPage('getting-started'),
    /class="token /,
    'no prism token markup — syntax highlighting regressed',
  );
});

test('mermaid diagrams are prerendered to inline SVG', () => {
  // aria-roledescription is emitted by mermaid itself, so it distinguishes a
  // real diagram from the 8+ theme icon <svg>s every page carries.
  for (const route of MERMAID_ROUTES) {
    const html = readPage(route);
    assert.match(html, /aria-roledescription=/, `route '${route}' has no prerendered mermaid SVG`);
    assert.doesNotMatch(
      html,
      /language-mermaid|```mermaid/,
      `route '${route}' still contains a raw mermaid fence — prerender fell through`,
    );
  }
});

test('mermaid markup does not leak onto pages without diagrams', () => {
  const others = DOC_ROUTES.filter((r) => !MERMAID_ROUTES.includes(r));
  for (const route of others) {
    assert.doesNotMatch(
      readPage(route),
      /aria-roledescription=/,
      `route '${route}' unexpectedly contains mermaid markup`,
    );
  }
});

test('landing page renders its sections', () => {
  const html = readPage('');
  assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1, 'landing page h1');

  const h2 = (html.match(/<h2[\s>]/g) ?? []).length;
  assert.ok(h2 >= 6, `landing page has ${h2} h2 sections, expected at least 6`);

  assert.ok(
    extractAttrs(html, 'id').includes('compare'),
    'landing page comparison section anchor (#compare) missing',
  );
});
