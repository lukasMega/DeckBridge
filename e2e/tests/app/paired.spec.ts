import { gotoApp } from '../../helpers/goto.js';
import { connectElgato, expect, test } from '../../fixtures/app.js';

test.describe('paired with the Elgato app (fake CORA client)', () => {
  test('hero flips to Ready on connect and back on disconnect', async ({ page, request, app }) => {
    await gotoApp(page, `${app.baseURL}/`);
    const stage = page.locator('#stage');
    await expect(stage).toContainText('Connect your control app');

    const elgato = await connectElgato(request, app.baseURL, app.childPort);
    try {
      // Pushed over the WS status channel — no reload.
      await expect(stage.locator('.stage-title')).toHaveText(/^Connected/);
    } finally {
      await elgato.close();
    }
    await expect(stage).toContainText('Connect your control app');
  });
});
