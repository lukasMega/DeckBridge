import { gotoApp } from '../../helpers/goto.js';
import { expect, test } from '../../fixtures/app.js';

// A restart on a different version (an update) must reload the open tab: it still runs the
// old ui.js. DECKBRIDGE_VERSION fakes the new server version (mock builds only).
test.describe('web UI after a server restart', () => {
  test.afterAll(async ({ app }) => {
    await app.restart();
  });

  test('reloads the tab when the server comes back on a new version', async ({ page, app }) => {
    await gotoApp(page, `${app.baseURL}/`);
    await expect(page.locator('#stage')).toBeVisible();
    await page.evaluate(() => {
      (window as unknown as { staleBundle: boolean }).staleBundle = true;
    });

    await app.restart({ DECKBRIDGE_VERSION: '9999.0.0' });

    // A fresh document has no staleBundle; the evaluate throws while it navigates.
    await expect
      .poll(
        () =>
          page
            .evaluate(() => (window as unknown as { staleBundle?: boolean }).staleBundle === true)
            .catch(() => true),
        { message: 'tab reloads after the version changed', timeout: 15_000 },
      )
      .toBe(false);
    await expect(page.locator('#stage')).toBeVisible();
  });

  test('keeps the tab when the server restarts on the same version', async ({ page, app }) => {
    await gotoApp(page, `${app.baseURL}/`);
    await page.evaluate(() => {
      (window as unknown as { staleBundle: boolean }).staleBundle = true;
    });

    await app.restart();
    // Past the 2 s reconnect delay: the tab must have rehydrated in place.
    await expect(page.locator('#stage')).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(4_000);
    expect(
      await page.evaluate(() => (window as unknown as { staleBundle?: boolean }).staleBundle),
    ).toBe(true);
  });
});
