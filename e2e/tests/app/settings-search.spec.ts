import { click, typeInto } from '../../helpers/click.js';
import { gotoApp } from '../../helpers/goto.js';
import { DEFAULT_DEVICE, expect, test, useDevice } from '../../fixtures/app.js';

test.beforeEach(async ({ page, request, app }) => {
  await useDevice(request, app.baseURL, DEFAULT_DEVICE);
  await gotoApp(page, `${app.baseURL}/`);
  await click(page.locator('#settingsBtn'));
});

test('search reveals nested controls and preserves drafts and expanded sections', async ({
  page,
}) => {
  const search = page.getByRole('searchbox', { name: 'Search settings' });
  const groups = page.locator('.settings-group:not([hidden])');
  const connection = page
    .locator('.collapsible')
    .filter({ has: page.locator('.identity-editable') });
  // This section is manually opened before searching; clearing must retain it.
  await click(connection.locator(':scope > .collapse-header'));
  const name = page.locator('.identity-editable input');
  await typeInto(name, 'Unsaved search draft');

  await typeInto(search, '  SHARPEN   sigma  ');
  await expect(groups).toHaveCount(1);
  await expect(groups).toHaveAttribute('aria-label', /Selected device/);
  await expect(page.getByLabel('Sharpen sigma')).toBeVisible();
  await typeInto(page.getByLabel('Sharpen sigma'), '0.7');

  await typeInto(search, 'no-such-setting-xyz');
  await expect(groups).toHaveCount(0);
  await expect(page.locator('.settings-page').getByRole('status')).toHaveText(
    'No settings found. Try another search.',
  );
  await click(page.getByRole('button', { name: 'Clear search' }));
  await expect(search).toHaveValue('');
  await expect(search).toBeFocused();
  await expect(groups).toHaveCount(6);
  await expect(name).toHaveValue('Unsaved search draft');
  await expect(connection.locator(':scope > .collapse-header')).not.toHaveClass(/collapsed/);
  await expect(page.locator('#device-tuning > .collapse-header')).toHaveClass(/collapsed/);

  await typeInto(search, 'sharpen');
  await expect(page.getByLabel('Sharpen sigma')).toHaveValue('0.7');
});

test('search covers every group, descriptions and import/export actions', async ({ page }) => {
  const search = page.getByRole('searchbox', { name: 'Search settings' });
  const groups = page.locator('.settings-group:not([hidden])');
  for (const title of [
    'Devices',
    'Selected device',
    'App connection',
    'Maintenance',
    'Integrations',
    'Advanced details',
  ]) {
    await typeInto(search, title);
    await expect(
      groups.filter({ has: page.getByRole('heading', { name: new RegExp(`^${title}`) }) }),
    ).toHaveCount(1);
  }
  await typeInto(search, 'Import');
  await expect(page.getByRole('button', { name: 'Import settings' })).toBeVisible();
  await expect(groups).toHaveCount(1);
  await typeInto(search, 'Reproduce problem');
  await expect(page.getByRole('button', { name: 'Create report' })).toBeVisible();
  await expect(groups).toHaveCount(1);
  await typeInto(search, '   ');
  await expect(groups).toHaveCount(6);
});

test('search updates when delayed settings finish loading', async ({ page, app }) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/device-overrides*', async (route) => {
    await pending;
    await route.continue();
  });
  try {
    await gotoApp(page, `${app.baseURL}/`);
    await click(page.locator('#settingsBtn'));
    await typeInto(page.getByRole('searchbox', { name: 'Search settings' }), 'sharpen sigma');
    await expect(page.locator('.settings-group:not([hidden])')).toHaveCount(0);
    release();
    await expect(page.getByLabel('Sharpen sigma')).toBeVisible();
    await expect(page.locator('.settings-group:not([hidden])')).toHaveCount(1);
  } finally {
    release();
  }
});
