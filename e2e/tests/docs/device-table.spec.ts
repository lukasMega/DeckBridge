import { click, typeInto } from '../../helpers/click.js';
import { expect, test } from '../../fixtures/docs.js';

/**
 * The highest-value docs target. DeviceTable/index.tsx:59-61 warns in-source that "initial
 * state must reproduce the SSR output exactly … or hydration mismatches and rows flash out
 * of existence" — exactly the class of bug only a live browser catches.
 */
test.describe('device tables', () => {
  test('filter narrows rows and Reset restores them', async ({ page, docs }) => {
    await page.goto(`${docs.baseURL}/device-specs`, { waitUntil: 'load' });

    // /device-specs mounts three DeviceTables (identity / image / wire). Take the first.
    const table = page.locator('table').first();
    const baseline = await table.locator('tbody tr').count();
    expect(baseline).toBeGreaterThan(0);

    // React SSR splits the count with comment nodes ("showing <!-- -->16<!-- --> of …"),
    // so match a pattern, never an exact string.
    await expect(page.locator('[aria-live="polite"]').first()).toHaveText(/showing \d+ of \d+/);

    await typeInto(page.locator('input[aria-label="Filter devices"]').first(), 'mirabox');
    await expect
      .poll(async () => table.locator('tbody tr').count(), { timeout: 10_000 })
      .toBeLessThan(baseline);

    // The Reset button only exists while a filter is active.
    await click(page.locator('button', { hasText: /^Reset$/ }).first());
    await expect
      .poll(async () => table.locator('tbody tr').count(), { timeout: 10_000 })
      .toBe(baseline);
  });

  test('column header cycles aria-sort ascending → descending → none', async ({ page, docs }) => {
    await page.goto(`${docs.baseURL}/device-specs`, { waitUntil: 'load' });

    const header = page.locator('th[scope="col"]').first();
    const button = header.locator('button').first();
    await expect(header).toHaveAttribute('aria-sort', 'none');

    await click(button);
    await expect(header).toHaveAttribute('aria-sort', 'ascending');
    await click(button);
    await expect(header).toHaveAttribute('aria-sort', 'descending');
    await click(button);
    await expect(header).toHaveAttribute('aria-sort', 'none');
  });

  test('summary table on the introduction page filters', async ({ page, docs }) => {
    await page.goto(`${docs.baseURL}/introduction`, { waitUntil: 'load' });

    const rows = page.locator('table tbody tr');
    const baseline = await rows.count();
    expect(baseline).toBeGreaterThan(0);

    await typeInto(page.locator('input[aria-label="Filter devices"]').first(), 'zzzznomatch');
    await expect.poll(async () => rows.count(), { timeout: 10_000 }).toBeLessThan(baseline);
    await expect(page.locator('table')).toContainText('No device matches that filter.');
  });
});
