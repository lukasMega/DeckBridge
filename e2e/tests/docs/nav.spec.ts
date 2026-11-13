import { click } from '../../helpers/click.js';
import { expect, test } from '../../fixtures/docs.js';

declare global {
  interface Window {
    __e2eMark?: string;
  }
}

test.describe('client-side navigation', () => {
  test('a sidebar link routes without a full page load', async ({ page, docs }) => {
    await page.goto(`${docs.baseURL}/introduction`, { waitUntil: 'load' });
    const before = await page.locator('h1').first().textContent();

    // A full reload would drop this; a client-side route change keeps it.
    await page.evaluate(() => {
      window.__e2eMark = 'alive';
    });

    const target = page.locator('.theme-doc-sidebar-menu a').nth(1);
    const href = await target.getAttribute('href');
    await click(target);

    await expect.poll(async () => page.url(), { timeout: 10_000 }).toContain(href ?? '');
    await expect(page.locator('h1').first()).not.toHaveText(before ?? '');
    expect(await page.evaluate(() => window.__e2eMark)).toBe('alive');
  });

  test('navbar Docs link reaches the docs root', async ({ page, docs }) => {
    await page.goto(`${docs.baseURL}/`, { waitUntil: 'load' });
    await click(page.locator('a.navbar__link', { hasText: 'Docs' }).first());
    await expect.poll(async () => page.url(), { timeout: 10_000 }).toContain('/introduction');
    await expect(page.locator('.theme-doc-sidebar-menu')).toHaveCount(1);
  });

  test('reader-rail state survives a client-side route change', async ({ page, docs }) => {
    await page.goto(`${docs.baseURL}/introduction`, { waitUntil: 'load' });

    // src/theme/Root.tsx installs a MutationObserver because react-helmet-async rewrites
    // the whole <html> class attribute inside a rAF on every navigation, wiping these
    // classes. That regression is only reproducible by actually navigating.
    await click(page.locator('button.db-toggle-btn', { hasText: 'Hide contents' }).first());
    await expect(page.locator('html')).toHaveClass(/db-hide-toc/);

    await click(page.locator('.theme-doc-sidebar-menu a').nth(1));
    await expect.poll(async () => page.url(), { timeout: 10_000 }).not.toContain('/introduction');
    await expect(page.locator('html')).toHaveClass(/db-hide-toc/);
  });
});
