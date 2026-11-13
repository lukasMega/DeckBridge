import { expect, test } from '../../fixtures/docs.js';

/**
 * Scope note: docs-site/scripts/*.mts already check routes, sitemap, internal links,
 * `#anchor` targets, one-h1-per-page, navbar/footer presence and mermaid prerendering
 * statically. Nothing here repeats that. These assertions are about the page being *alive*
 * after hydration.
 */
test.describe('pages hydrate', () => {
  test('home page renders its interactive hero', async ({ page, docs }) => {
    const res = await page.goto(`${docs.baseURL}/`, { waitUntil: 'load' });
    expect(res?.status()).toBe(200);

    await expect(page.locator('h1')).not.toBeEmpty();
    expect(await page.locator('a.navbar__link').count()).toBeGreaterThanOrEqual(2);

    // RotatingWord renders every brand and marks one active; the marker only exists once
    // the component has mounted.
    expect(await page.locator('[data-active]').count()).toBeGreaterThanOrEqual(2);
    await expect(page.locator('[data-active="true"]')).toHaveCount(1);

    await expect(page.locator('svg[role="img"][aria-label^="Data flow"]')).toHaveCount(1);
    await expect(page.locator('section#compare')).toHaveCount(1);
  });

  test('a docs route renders article, sidebar and TOC', async ({ page, docs }) => {
    const res = await page.goto(`${docs.baseURL}/introduction`, { waitUntil: 'load' });
    expect(res?.status()).toBe(200);

    expect(await page.locator('.theme-doc-sidebar-menu a').count()).toBeGreaterThanOrEqual(5);
    const article = await page.locator('article').first().textContent();
    expect((article ?? '').length).toBeGreaterThan(1000);
  });

  test('prerendered mermaid survives into the live DOM', async ({ page, docs }) => {
    await page.goto(`${docs.baseURL}/image-flow`, { waitUntil: 'load' });
    // No mermaid runtime ships to the client (the theme is not registered); the SVG is
    // baked in at build time by plugins/remark-mermaid-prerender.mjs. This asserts React
    // does not strip it during hydration.
    await expect(page.locator('.docusaurus-mermaid-container')).not.toHaveCount(0);
    await expect(page.locator('.docusaurus-mermaid-container svg').first()).toHaveCount(1);
  });

  test('search box hydrates and its index is fetchable', async ({ page, docs }) => {
    await page.goto(`${docs.baseURL}/introduction`, { waitUntil: 'load' });
    const input = page.locator('input[aria-label="Search"]');
    await expect(input).toHaveCount(1);
    await expect(input).toBeEnabled();

    // The local search index only exists in a production build — this is the assertion
    // that catches "site served from the dev server" and "hashed index missing".
    const indexOk = await page.evaluate(async () => {
      const src = Array.from(document.querySelectorAll('script[src]')).map(
        (s) => (s as HTMLScriptElement).src,
      );
      const found = src.some((u) => /search-index/.test(u));
      const direct = await fetch('/DeckBridge/search-index.json').then(
        (r) => r.ok,
        () => false,
      );
      return found || direct;
    });
    expect(indexOk).toBe(true);
  });

  test('unknown route serves the 404 page', async ({ page, docs }) => {
    const res = await page.goto(`${docs.baseURL}/definitely-missing`, { waitUntil: 'load' });
    expect(res?.status()).toBe(404);
    await expect(page.locator('h1')).toHaveText('Page Not Found');
  });
});
