import { gotoApp } from '../../helpers/goto.js';
import { click, doubleClick } from '../../helpers/click.js';
import { connectElgato, expect, nextFrame, test } from '../../fixtures/app.js';

test.describe('paired with the Elgato app (fake CORA client)', () => {
  test('connected summary dismisses without hiding controls and returns after reconnect', async ({
    page,
    request,
    app,
  }) => {
    await gotoApp(page, `${app.baseURL}/`);
    const stage = page.locator('#stage');
    await expect(stage).toContainText('Connect your control app');

    const elgato = await connectElgato(request, app.baseURL, app.childPort);
    try {
      // Pushed over the WS status channel — no reload.
      await expect(stage.locator('.stage-title')).toHaveText(/^Connected/);
      await click(stage.getByRole('button', { name: 'Hide connection status' }));
      await expect(stage.locator('.ready-status')).toHaveCount(0);
      await expect(stage.locator('.key-grid')).toHaveCount(1);
      await expect(page.locator('#simple-brightness')).toBeEnabled();
    } finally {
      await elgato.close();
    }
    await expect(stage).toContainText('Connect your control app');
    await expect(stage.getByRole('list', { name: 'Connection path' })).toHaveCount(1);

    const reconnected = await connectElgato(request, app.baseURL, app.childPort);
    try {
      await expect(stage.locator('.stage-title')).toHaveText(/^Connected/);
      await expect(stage.getByRole('button', { name: 'Hide connection status' })).toHaveCount(1);
    } finally {
      await reconnected.close();
    }
  });

  test('double-clicking a preview key presses it (click-to-press)', async ({
    page,
    request,
    app,
  }) => {
    await gotoApp(page, `${app.baseURL}/`);
    const elgato = await connectElgato(request, app.baseURL, app.childPort);
    try {
      // app-server.ts turns the click-to-press setting on; pairing makes the keys clickable.
      const cell = page.locator('#stage .key-cell.clickable[data-key="3"]');
      await expect(cell).toHaveCount(1);
      const frame = await nextFrame(
        app.baseURL,
        (f) => f.event === 'keyEvent' && f.data.mk2Index === 3,
        () => doubleClick(cell),
      );
      expect(frame.data.state).toBe('down');
    } finally {
      await elgato.close();
    }
  });
});
