import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { click } from '../../helpers/click.js';
import { expect, test } from '../../fixtures/docs.js';

test.describe('live demo', () => {
  test('demo page embeds the browser bundle', async ({ page, docs }) => {
    await page.goto(`${docs.baseURL}/demo/`, { waitUntil: 'load' });
    await expect(page.locator('h1')).toHaveText('Live demo');
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
      await page.addInitScript(() => {
        Reflect.set(window, 'demoHidCalls', 0);
        Object.defineProperty(Reflect.get(navigator, 'hid'), 'requestDevice', {
          value: () => {
            Reflect.set(window, 'demoHidCalls', Reflect.get(window, 'demoHidCalls') + 1);
            Reflect.set(window, 'demoHidActivation', navigator.userActivation.isActive);
            return Promise.resolve([]);
          },
        });
      });
      const clockStart = new Date('2026-10-10T12:00:00Z');
      await page.clock.install({ time: clockStart });
      await page.clock.pauseAt(clockStart);
      const nativeIcon = (state: string) =>
        `data:image/png;base64,${readFileSync(new URL(`../../../rust/deckbridge-tray/icons/icon-${state}.png`, import.meta.url)).toString('base64')}`;
      await page.goto(`${docs.baseURL}/demo/`, { waitUntil: 'load' });
      const tray = page.getByRole('button', { name: 'DeckBridge tray', exact: true });
      await expect(tray).toHaveCount(0);
      await page.clock.runFor(1000);
      await expect(page.getByText('Click to run DeckBridge', { exact: true })).not.toBeVisible();
      await page.clock.runFor(1100);
      await expect(page.getByText('Click to run DeckBridge', { exact: true })).toBeVisible();
      await page.clock.resume();
      await page.getByRole('button', { name: 'Run DeckBridge', exact: true }).click();
      await expect(tray.locator('img')).toHaveAttribute('src', nativeIcon('disconnected'));
      await tray.click();
      await page.getByRole('button', { name: 'Open Web UI', exact: true }).click();
      const demo = page.frameLocator('iframe[title="DeckBridge demo"]');
      const controls = page.getByRole('region', { name: 'Demo controls', exact: true });
      const handle = controls.getByRole('button', { name: 'Move demo controls', exact: true });
      await expect(controls).toBeVisible();
      await expect(demo.getByRole('region', { name: 'Demo controls', exact: true })).toHaveCount(0);
      const initialPanel = (await controls.boundingBox())!;
      const grip = (await handle.boundingBox())!;
      await page.mouse.move(grip.x + 20, grip.y + grip.height / 2);
      await page.mouse.down();
      await page.mouse.move(grip.x + 20, grip.y + grip.height / 2 + 48, { steps: 6 });
      await page.mouse.up();
      await expect
        .poll(async () => (await controls.boundingBox())!.y)
        .toBeCloseTo(initialPanel.y + 48);
      await handle.press('ArrowDown');
      await expect
        .poll(async () => (await controls.boundingBox())!.y)
        .toBeCloseTo(initialPanel.y + 60);
      await handle.press('Home');
      await expect.poll(async () => (await controls.boundingBox())!.y).toBeCloseTo(initialPanel.y);
      await page.setViewportSize({ width: 781, height: 613 });
      const mockMode = controls.getByRole('tab', { name: 'Mock', exact: true });
      await mockMode.hover();
      await expect
        .poll(() => mockMode.evaluate((element) => getComputedStyle(element, '::after').visibility))
        .toBe('visible');
      await mockMode.click();
      await expect
        .poll(() => mockMode.evaluate((element) => getComputedStyle(element, '::after').visibility))
        .toBe('hidden');
      await handle.hover();
      await mockMode.hover();
      await expect
        .poll(() => mockMode.evaluate((element) => getComputedStyle(element, '::after').visibility))
        .toBe('visible');
      await handle.hover();
      await mockMode.focus();
      await expect
        .poll(() => mockMode.evaluate((element) => getComputedStyle(element, '::after').visibility))
        .toBe('hidden');
      const mockPanel = (await controls.boundingBox())!;
      expect(mockPanel.width).toBe(400);
      expect(mockPanel.height).toBeLessThan(100);
      await expect(controls.locator('.demo-drag-handle').getByRole('tablist')).toBeVisible();
      await expect(
        controls.getByRole('button', { name: 'Connect device', exact: true }),
      ).not.toBeVisible();
      await controls.getByRole('tab', { name: 'Real device', exact: true }).click();
      await expect
        .poll(() => controls.boundingBox())
        .toMatchObject({
          x: mockPanel.x,
          y: mockPanel.y,
          width: mockPanel.width,
          height: mockPanel.height,
        });
      await expect(controls.getByRole('combobox', { name: 'Device model' })).not.toBeVisible();
      await expect(
        controls.getByRole('button', { name: 'Plug in', exact: true }),
      ).not.toBeVisible();
      await expect(controls.getByRole('button', { name: 'Reset', exact: true })).not.toBeVisible();
      const connectModal = page.getByRole('dialog', { name: 'Before connecting', exact: true });
      const connectionInstructions = page.getByText(
        'Quit DeckBridge and your deck’s vendor app first, so the browser can open the deck.',
        { exact: true },
      );
      const connectButton = controls.getByRole('button', { name: 'Connect device', exact: true });
      const demoFrame = page.locator('iframe[title="DeckBridge demo"]');
      const hidCalls = () =>
        demoFrame.evaluate((element) =>
          Reflect.get((element as HTMLIFrameElement).contentWindow!, 'demoHidCalls'),
        );
      await expect(connectionInstructions).not.toBeVisible();
      await connectButton.click();
      await expect(connectModal).toBeVisible();
      await expect(connectionInstructions).toBeVisible();
      await expect.poll(hidCalls).toBe(0);
      await connectModal.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(connectModal).not.toBeVisible();
      await expect(connectButton).toBeFocused();
      await connectButton.click();
      await page.keyboard.press('Escape');
      await expect(connectModal).not.toBeVisible();
      await expect.poll(hidCalls).toBe(0);
      await connectButton.click();
      await connectModal.getByRole('button', { name: 'Continue', exact: true }).click();
      await expect(connectModal).not.toBeVisible();
      await expect.poll(hidCalls).toBe(1);
      expect(
        await demoFrame.evaluate((element) =>
          Reflect.get((element as HTMLIFrameElement).contentWindow!, 'demoHidActivation'),
        ),
      ).toBe(true);
      await mockMode.click();
      await expect
        .poll(() => controls.boundingBox())
        .toMatchObject({
          width: mockPanel.width,
          height: mockPanel.height,
        });
      await expect(controls.getByRole('combobox', { name: 'Device model' })).toBeEnabled();
      await expect(controls.getByRole('button', { name: 'Plug in', exact: true })).toBeEnabled();
      await expect(controls.getByRole('button', { name: 'Reset', exact: true })).toBeEnabled();
      await page.setViewportSize({ width: 360, height: 640 });
      await expect
        .poll(async () => {
          const rect = (await controls.boundingBox())!;
          return rect.x + rect.width;
        })
        .toBeLessThanOrEqual(360);
      const mobilePanel = (await controls.boundingBox())!;
      expect(mobilePanel.x).toBeGreaterThanOrEqual(0);
      expect(mobilePanel.x + mobilePanel.width).toBeLessThanOrEqual(360);
      expect(mobilePanel.height).toBeLessThan(100);
      await expect(mockMode).toBeVisible();
      await expect(controls.getByRole('combobox', { name: 'Device model' })).toBeVisible();
      await expect(controls.getByRole('button', { name: 'Reset', exact: true })).toBeVisible();
      await page.setViewportSize({ width: 781, height: 613 });
      await handle.press('Home');
      const pairedModal = page.getByRole('dialog', { name: 'Demo pairing complete', exact: true });
      await expect(pairedModal).not.toBeVisible();
      await controls.getByRole('button', { name: 'Plug in', exact: true }).click();
      await expect(tray.locator('img')).toHaveAttribute('src', nativeIcon('usb-only'));
      await expect(pairedModal).not.toBeVisible();
      await demo.getByRole('button', { name: 'Yes', exact: true }).click();
      await demo.getByRole('button', { name: 'Open Elgato app', exact: true }).click();
      await expect(tray.locator('img')).toHaveAttribute('src', nativeIcon('full'));
      await expect(pairedModal).toContainText('This demo cannot connect to the Elgato app.');
      await expect(pairedModal).toContainText(
        'Run the native DeckBridge app on your PC to control your Stream Deck MK.2 buttons with the Elgato app.',
      );
      await pairedModal.getByRole('button', { name: 'Got it', exact: true }).click();
      await demo.getByRole('slider', { name: 'Screen brightness' }).press('ArrowLeft');
      await expect(pairedModal).not.toBeVisible();
      await page.getByRole('button', { name: 'Close demo window', exact: true }).click();
      await expect(tray).toBeVisible();
      await expect(controls).not.toBeVisible();
      await tray.click();
      await page.getByRole('button', { name: 'Open Web UI', exact: true }).click();
      await expect(controls).toBeVisible();
      await expect(demo.locator('h1.stage-title')).toHaveText('Connected to the Elgato app');
      await expect(pairedModal).not.toBeVisible();
      await controls.getByRole('combobox', { name: 'Device model' }).selectOption('mini');
      await controls.getByRole('button', { name: 'Plug in', exact: true }).click();
      await demo.getByRole('button', { name: 'Yes', exact: true }).click();
      await demo.getByRole('button', { name: 'Open Elgato app', exact: true }).click();
      await expect(pairedModal).toContainText(
        'Run the native DeckBridge app on your PC to control your Stream Deck Mini buttons with the Elgato app.',
      );
      await page.keyboard.press('Escape');
      await expect(pairedModal).not.toBeVisible();
      await tray.click();
      await page.getByRole('button', { name: 'Quit', exact: true }).click();
      await expect(tray).toHaveCount(0);
      await expect(page.locator('iframe')).toHaveCount(0);
      await expect(controls).toHaveCount(0);
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
