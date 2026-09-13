import { click, pressEscape } from '../../helpers/click.js';
import { expect, test } from '../../fixtures/app.js';

test.describe('the controls a user touches first', () => {
  test('theme button cycles light → dark → auto', async ({ page, app }) => {
    await page.goto(`${app.baseURL}/`);
    // ThemeButton reads localStorage at mount, so seed it for a deterministic start.
    await page.evaluate(() => localStorage.setItem('deckbridge.theme', 'light'));
    await page.reload({ waitUntil: 'load' });

    const button = page.locator('#themeBtn');
    const html = page.locator('html');
    await expect(button).toHaveAttribute('aria-label', 'Theme: Light. Click to change.');
    await expect(html).toHaveAttribute('data-theme', 'light');

    await click(button);
    await expect(button).toHaveAttribute('aria-label', 'Theme: Dark. Click to change.');
    await expect(html).toHaveAttribute('data-theme', 'dark');

    await click(button);
    await expect(button).toHaveAttribute('aria-label', 'Theme: Auto. Click to change.');
  });

  test('About popover opens and closes on Escape', async ({ page, app }) => {
    await page.goto(`${app.baseURL}/`);
    await click(page.locator('#aboutBtn'));
    await expect(page.locator('.popover h2')).toHaveText('What is DeckBridge?');

    const popover = page.locator('.popover');
    await pressEscape(page, async () => (await popover.count()) === 0);
    await expect(popover).toHaveCount(0);
  });

  test('Settings page opens and backs out', async ({ page, app }) => {
    await page.goto(`${app.baseURL}/`);
    await click(page.locator('#settingsBtn'));
    await expect(page.locator('.help h1')).toHaveText('Settings');

    const grid = page.locator('#stage .key-grid');
    await pressEscape(page, async () => (await grid.count()) === 1);
    await expect(grid).toHaveCount(1);
  });

  test('help chip opens the matching topic and returns', async ({ page, app }) => {
    await page.goto(`${app.baseURL}/`);
    // data-help is the closest thing to a test id in ts/src (ids live in ui-help.ts).
    // Only the network-device chip is on screen in this stage — the plug-in/open-app
    // chips belong to the "no device" stage, which mock mode never reaches.
    await click(page.locator('button[data-help="network-device"]'));
    // The <h1> is a sibling of .help-stage (which holds only the topic SVG), not a child.
    await expect(page.locator('.help h1')).toHaveText('Add it as a network device');
    await expect(page.locator('ol.help-steps li').first()).not.toBeEmpty();

    await click(page.locator('button.help-back'));
    await expect(page.locator('#stage .key-grid')).toHaveCount(1);
  });
});
