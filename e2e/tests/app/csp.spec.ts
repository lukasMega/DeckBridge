import { click, pressEscape } from '../../helpers/click.js';
import { gotoApp } from '../../helpers/goto.js';
import { expect, test } from '../../fixtures/app.js';

const CSP_PATTERN = /Content Security Policy/i;

test.describe('Content-Security-Policy', () => {
  test('the home page and its dialogs raise no CSP violation', async ({ page, app, request }) => {
    // Violations arrive as console errors; the fixture's pageerror hook only sees exceptions.
    const cspMessages: string[] = [];
    page.on('console', (msg) => {
      if ((msg.type() === 'error' || msg.type() === 'warning') && CSP_PATTERN.test(msg.text())) {
        cspMessages.push(msg.text());
      }
    });
    page.on('pageerror', (err) => {
      if (CSP_PATTERN.test(String(err))) cspMessages.push(String(err));
    });

    const headers = (await request.get(`${app.baseURL}/`)).headers();
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");

    await gotoApp(page, `${app.baseURL}/`);
    // ThemeButton reads localStorage at mount; dark exercises the theme-dependent styles.
    await page.evaluate(() => localStorage.setItem('deckbridge.theme', 'dark'));
    await page.reload({ waitUntil: 'load' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await click(page.locator('#settingsBtn'));
    await expect(page.locator('.help h1')).toHaveText('Settings');
    const grid = page.locator('#stage .key-grid');
    await pressEscape(page, async () => (await grid.count()) === 1);

    await click(page.locator('#aboutBtn'));
    await expect(page.locator('.popover h2')).toHaveText('What is DeckBridge?');
    const popover = page.locator('.popover');
    await pressEscape(page, async () => (await popover.count()) === 0);

    expect(
      cspMessages,
      `CSP violations seen on the page:\n${cspMessages.join('\n') || '(none)'}`,
    ).toEqual([]);
  });
});
