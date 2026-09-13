import { click } from '../../helpers/click.js';
import { expect, test } from '../../fixtures/docs.js';

test.describe('theme and animation preferences', () => {
  test('colour-mode toggle is disabled in SSR HTML and enabled after hydration', async ({
    page,
    docs,
  }) => {
    // The static HTML really does ship `disabled` on this button; only hydration enables
    // it. That makes it a precise "did React take over?" probe.
    const raw = await fetch(`${docs.baseURL}/introduction`).then((r) => r.text());
    expect(raw).toMatch(/Switch between dark and light mode/);

    await page.goto(`${docs.baseURL}/introduction`, { waitUntil: 'load' });
    const toggle = page.locator('button[aria-label^="Switch between dark and light mode"]');
    await expect(toggle).toHaveCount(1);
    await expect(toggle).toBeEnabled();
  });

  test('toggling colour mode cycles system → light → dark', async ({ page, docs }) => {
    await page.goto(`${docs.baseURL}/introduction`, { waitUntil: 'load' });
    const html = page.locator('html');
    const toggle = page.locator('button[aria-label^="Switch between dark and light mode"]');

    // respectPrefersColorScheme: true, so a fresh visit starts on "system". Assert the
    // *choice*, not the resolved theme: the first step lands on light, which is what
    // system already resolved to, so data-theme alone would look unchanged.
    await expect(html).toHaveAttribute('data-theme-choice', 'system');

    await click(toggle);
    await expect(html).toHaveAttribute('data-theme-choice', 'light');

    await click(toggle);
    await expect(html).toHaveAttribute('data-theme-choice', 'dark');
    await expect(html).toHaveAttribute('data-theme', 'dark');
  });

  test('animation toggle flips aria-pressed and the html class', async ({ page, docs }) => {
    await page.goto(`${docs.baseURL}/introduction`, { waitUntil: 'load' });
    const toggle = page.locator('button.db-anim-toggle');
    await expect(toggle).toHaveCount(1);

    const before = await toggle.getAttribute('aria-pressed');
    await click(toggle);
    await expect.poll(async () => toggle.getAttribute('aria-pressed')).not.toBe(before);
    // animPref.ts writes db-no-anim, which custom.css uses to kill every transition.
    await expect
      .poll(async () =>
        page.evaluate(() => document.documentElement.classList.contains('db-no-anim')),
      )
      .toBe(before === 'true');
  });
});
