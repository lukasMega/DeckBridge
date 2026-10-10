import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { click } from '../../helpers/click.js';
import { expect, test } from '../../fixtures/docs.js';

test.describe('live demo', () => {
  test('demo page embeds the browser bundle', async ({ page, docs }) => {
    await page.goto(`${docs.baseURL}/demo/`, { waitUntil: 'load' });
    await expect(page.locator('h1')).toHaveText('Try DeckBridge');
    await click(page.getByRole('button', { name: 'Run DeckBridge', exact: true }));
    await expect(page.locator('iframe[title="DeckBridge demo"]')).toHaveAttribute(
      'src',
      /\/demo-app\/index\.html$/,
    );
  });

  test('desktop launch adds tray and tracks pairing until quit', async ({ docs }) => {
    // Lightpanda cannot interact with this dynamically mounted iframe.
    const browser = await chromium.launch({
      executablePath:
        process.env.CHROME_BIN ??
        (process.platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : undefined),
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    try {
      const page = await browser.newPage();
      const nativeIcon = (state: string) =>
        `data:image/png;base64,${readFileSync(new URL(`../../../rust/deckbridge-tray/icons/icon-${state}.png`, import.meta.url)).toString('base64')}`;
      await page.goto(`${docs.baseURL}/demo/`, { waitUntil: 'load' });
      const tray = page.getByRole('button', { name: 'DeckBridge tray', exact: true });
      await expect(tray).toHaveCount(0);
      await expect(page.getByText('Click to run DeckBridge', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Run DeckBridge', exact: true }).click();
      await expect(tray.locator('img')).toHaveAttribute('src', nativeIcon('disconnected'));
      await tray.click();
      await page.getByRole('button', { name: 'Open Web UI', exact: true }).click();
      const demo = page.frameLocator('iframe[title="DeckBridge demo"]');
      const pairedModal = page.getByRole('dialog', { name: 'Paired!', exact: true });
      await expect(pairedModal).not.toBeVisible();
      await demo.getByRole('button', { name: 'Plug in', exact: true }).click();
      await expect(tray.locator('img')).toHaveAttribute('src', nativeIcon('usb-only'));
      await expect(pairedModal).not.toBeVisible();
      await demo.getByRole('button', { name: 'Yes', exact: true }).click();
      await demo.getByRole('button', { name: 'Open Elgato app', exact: true }).click();
      await expect(tray.locator('img')).toHaveAttribute('src', nativeIcon('full'));
      await expect(pairedModal).toContainText(
        'Now you can control your Stream Deck MK.2 buttons with the Elgato app.',
      );
      await pairedModal.getByRole('button', { name: 'Got it', exact: true }).click();
      await demo.getByRole('slider', { name: 'Screen brightness' }).press('ArrowLeft');
      await expect(pairedModal).not.toBeVisible();
      await page.getByRole('button', { name: 'Close demo window', exact: true }).click();
      await expect(tray).toBeVisible();
      await tray.click();
      await page.getByRole('button', { name: 'Open Web UI', exact: true }).click();
      await expect(demo.locator('h1.stage-title')).toHaveText('Connected to the Elgato app');
      await expect(pairedModal).not.toBeVisible();
      await demo.getByRole('combobox', { name: 'Device model' }).selectOption('mini');
      await demo.getByRole('button', { name: 'Plug in', exact: true }).click();
      await demo.getByRole('button', { name: 'Yes', exact: true }).click();
      await demo.getByRole('button', { name: 'Open Elgato app', exact: true }).click();
      await expect(pairedModal).toContainText(
        'Now you can control your Stream Deck Mini buttons with the Elgato app.',
      );
      await page.keyboard.press('Escape');
      await expect(pairedModal).not.toBeVisible();
      await tray.click();
      await page.getByRole('button', { name: 'Quit', exact: true }).click();
      await expect(tray).toHaveCount(0);
      await expect(page.locator('iframe')).toHaveCount(0);
      await expect(page.getByText('Click to run DeckBridge', { exact: true })).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('mock demo moves from no device through pairing to ready', async ({ page, docs }) => {
    await page.goto(`${docs.baseURL}/demo-app/index.html`, { waitUntil: 'load' });
    await expect(page.locator('h1.stage-title')).toHaveText('Connect your device');
    await expect(page.locator('select')).toHaveCount(1);
    await expect(page.locator('#settingsBtn')).toHaveCount(0);
    await expect(page.locator('#footerFeedback')).toHaveCount(0);

    await click(page.getByRole('button', { name: 'Plug in', exact: true }));
    await expect(page.locator('h1.stage-title')).toHaveText('Connect your control app');
    await click(page.getByRole('button', { name: 'Yes', exact: true }));
    await click(page.getByRole('button', { name: 'Open Elgato app', exact: true }));
    await expect(page.locator('h1.stage-title')).toHaveText('Connected to the Elgato app', {
      timeout: 3000,
    });
    await expect(page.locator('#settingsBtn')).toHaveCount(0);
    await expect(page.locator('#footerFeedback')).toHaveCount(0);
  });

  test('demo artwork stays upright across preview orientation variants', async ({ docs }) => {
    // CSS transforms need a renderer; Lightpanda cannot verify orientation.
    const browser = await chromium.launch({
      executablePath:
        process.env.CHROME_BIN ??
        (process.platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : undefined),
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    try {
      const page = await browser.newPage();
      await page.goto(`${docs.baseURL}/demo-app/index.html`, { waitUntil: 'load' });
      const picker = page.getByRole('combobox', { name: 'Device model' });
      for (const model of ['mk2', 'mini', 'mirabox-k1pro', 'ajazz-akp05e']) {
        await picker.selectOption(model);
        await page.getByRole('button', { name: 'Plug in', exact: true }).click();
        await page.getByRole('button', { name: 'Yes', exact: true }).click();
        await page.getByRole('button', { name: 'Open Elgato app', exact: true }).click();
        const grid = page.locator('#stage .key-grid');
        await expect(grid).toHaveAttribute('data-model', model);
        const images = grid.locator('img');
        await expect(images).toHaveCount(await grid.locator('.key-cell').count());
        await expect(images.first()).toBeVisible();
        for (const image of await images.all()) await expect(image).toHaveCSS('transform', 'none');
      }
    } finally {
      await browser.close();
    }
  });
});
