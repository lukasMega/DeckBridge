import {
  test as base,
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

/**
 * Forbidden in every spec built on this fixture — Lightpanda has no rendering or layout
 * engine, so these silently return stubs instead of failing loudly:
 *
 *   page.screenshot() / toHaveScreenshot()   → a hardcoded placeholder image
 *   page.pdf()                                → a hardcoded placeholder PDF
 *   locator.boundingBox()                     → a fake 5x5 rect
 *   locator.click() / hover() / dragTo()      → hang on the actionability check
 *
 * Use helpers/click.ts for interaction, and assert on DOM state, attributes, text and
 * network instead of pixels.
 */

const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function connect(): Promise<Browser> {
  if (process.env.E2E_BROWSER === 'chromium') {
    // Triage path: same product assertions, a real renderer. Uses $CHROME_BIN like
    // ts/scripts/test-client.mjs does.
    const executablePath =
      process.env.CHROME_BIN ?? (process.platform === 'darwin' ? DEFAULT_CHROME : undefined);
    return chromium.launch({ executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  }
  const endpoint = process.env.E2E_CDP_ENDPOINT;
  if (endpoint === undefined) {
    throw new Error('E2E_CDP_ENDPOINT unset — global-setup.ts did not start Lightpanda');
  }
  return chromium.connectOverCDP(endpoint);
}

/**
 * We override `browser`, `context` and `page` rather than using Playwright's built-ins so
 * that `newContext()` is called with **no options**: the defaults (viewport, colour
 * scheme, service workers) are meaningless without a renderer and Lightpanda rejects some
 * of them.
 */
export const test = base.extend<{ context: BrowserContext; page: Page }, { browser: Browser }>({
  browser: [
    async ({}, use) => {
      const browser = await connect();
      await use(browser);
      await browser.close();
    },
    { scope: 'worker' },
  ],

  context: async ({ browser }, use) => {
    const context = await browser.newContext();
    await use(context);
    await context.close();
  },

  page: async ({ context }, use) => {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    await use(page);
    await page.close();
    // Surface uncaught page exceptions: a hydration crash otherwise shows up only as a
    // confusing selector timeout somewhere further down the spec.
    if (errors.length > 0) throw new Error(`uncaught page error(s):\n${errors.join('\n')}`);
  },
});

export { expect } from '@playwright/test';
