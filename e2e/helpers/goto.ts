import type { Page } from '@playwright/test';

/** Lightpanda's CDP session occasionally times out a navigation for no product-side
 *  reason (see e2e/README.md's Lightpanda-vs-Chromium note) — one retry absorbs it
 *  without masking a genuine load failure, which fails again on the retry too. */
export async function gotoApp(page: Page, url: string): Promise<void> {
  try {
    await page.goto(url);
  } catch {
    await page.goto(url);
  }
}
