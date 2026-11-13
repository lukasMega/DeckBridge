import { click, typeInto } from '../../helpers/click.js';
import { gotoApp } from '../../helpers/goto.js';
import {
  api,
  DEFAULT_DEVICE,
  deviceEntry,
  dock0,
  expect,
  getSettings,
  getState,
  restoreSettings,
  test,
  useDevice,
  type SettingsJson,
} from '../../fixtures/app.js';

const KEY = `mock:${DEFAULT_DEVICE}`;
const RENAMED = 'E2E Renamed Dock';

interface UpdateInfo {
  enabled: boolean;
  current: string;
  dismissedVersion?: string;
  lastCheckedAt?: number;
  latest?: string;
}

async function openSettings(page: import('@playwright/test').Page): Promise<void> {
  await click(page.locator('#settingsBtn'));
  await expect(page.locator('.help h1')).toHaveText('Settings');
  for (const title of ['Multiple decks', 'Logging & diagnostics', 'Connection details']) {
    await click(page.getByRole('heading', { name: new RegExp(`^${title}`) }));
  }
}

// Device-independent panels, all on MK.2. Mock mode never runs the GitHub update check
// (app.ts), and every spec here also fails if the page asks for one.
test.describe('Settings page panels', () => {
  let snapshot: SettingsJson;
  let bootName: string;
  let bootLevel: string;
  let bootUpdates: boolean;

  test.beforeAll(async ({ app, workerRequest }) => {
    await useDevice(workerRequest, app.baseURL, DEFAULT_DEVICE);
    snapshot = await getSettings(workerRequest, app.baseURL);
    const state = await getState(workerRequest, app.baseURL);
    bootName = dock0(state).mdnsServiceName;
    bootLevel = state.logLevel as string;
    bootUpdates = (state.updateInfo as UpdateInfo).enabled;
  });

  const updateChecks: string[] = [];
  test.beforeEach(async ({ page }) => {
    page.on('request', (r) => {
      if (r.url().endsWith('/api/update/check')) updateChecks.push(r.url());
    });
  });
  test.afterEach(() => {
    expect(updateChecks, 'the page must never ask for an update check').toEqual([]);
  });

  test.afterAll(async ({ app, workerRequest }) => {
    const base = app.baseURL;
    // The live advert follows only the rename route, not a settings import.
    await api(workerRequest, base, '/api/device-identity/mdns-name', {
      deviceKey: KEY,
      name: bootName,
    });
    await api(workerRequest, base, '/api/log-level', { level: bootLevel });
    await api(workerRequest, base, '/api/update-check-enabled', { enabled: bootUpdates });
    await useDevice(workerRequest, base, DEFAULT_DEVICE);
    await restoreSettings(workerRequest, base, snapshot);
  });

  test('identity rename, multi-deck and debug logging from the page', async ({
    page,
    request,
    app,
  }) => {
    const base = app.baseURL;
    await api(request, base, '/api/multi-deck', { enabled: false });
    // Known start: the build-time default level may itself be debug (`mise run d`).
    await api(request, base, '/api/log-level', { level: 'info' });
    await gotoApp(page, `${base}/`);
    await openSettings(page);

    // mDNS rename: the mock dock has a deviceKey, so the row is editable.
    const row = page.locator('.identity-editable');
    await expect(row).toHaveCount(1);
    await typeInto(row.locator('input'), RENAMED);
    const renamed = page.waitForRequest((r) => r.url().endsWith('/api/device-identity/mdns-name'));
    await click(row.getByRole('button', { name: 'Save' }));
    expect((await renamed).postDataJSON()).toEqual({ deviceKey: KEY, name: RENAMED });
    await expect
      .poll(async () => (await deviceEntry(request, base, KEY))?.mdnsServiceName)
      .toBe(RENAMED);
    const state = await getState(request, base);
    expect(dock0(state).mdnsServiceName).toBe(RENAMED);
    expect((state.deviceIdentity as { mdnsServiceName: string }).mdnsServiceName).toBe(RENAMED);

    // Multi-deck: the toggle posts, and a fresh mount of the page reads it back.
    const toggle = page.locator('#toggle-multi-deck');
    await expect(toggle).not.toBeChecked();
    const multi = page.waitForRequest((r) => r.url().endsWith('/api/multi-deck'));
    await click(toggle);
    expect((await multi).postDataJSON()).toEqual({ enabled: true });
    await expect.poll(async () => (await getState(request, base)).multiDeck).toBe(true);
    expect((await getSettings(request, base)).multiDeck).toBe(true);

    // Debug logging: the button posts, the level in effect follows.
    const debug = page.locator('#toggle-debug-logging');
    await expect(debug).toHaveText('Debug logging: off');
    const level = page.waitForRequest((r) => r.url().endsWith('/api/log-level'));
    await click(debug);
    expect((await level).postDataJSON()).toEqual({ level: 'debug' });
    await expect(debug).toHaveText('Debug logging: on');
    await expect.poll(async () => (await getState(request, base)).logLevel).toBe('debug');

    // Remount (Back, then Settings again): both toggles are read back from the server.
    await click(page.locator('button.help-back'));
    await expect(page.locator('#stage .key-grid')).toHaveCount(1);
    await openSettings(page);
    await expect(page.locator('#toggle-multi-deck')).toBeChecked();
    await expect(page.locator('#toggle-debug-logging')).toHaveText('Debug logging: on');
    await expect(page.locator('.identity-editable input')).toHaveValue(RENAMED);
  });

  test('a failed rename shows "Save failed"', async ({ page, request, app }) => {
    const base = app.baseURL;
    // The server's own 404 for an identity it never persisted.
    const unknown = await api<{ error: string }>(request, base, '/api/device-identity/mdns-name', {
      deviceKey: 'mock:nope',
      name: 'x',
    });
    expect(unknown.status).toBe(404);
    expect(unknown.json.error).toContain('mock:nope');
    expect(
      (await api(request, base, '/api/device-identity/mdns-name', { deviceKey: KEY, name: ' ' }))
        .status,
    ).toBe(400);

    // The UI's wording when the save fails without a server message.
    await page.route('**/api/device-identity/mdns-name', (route) =>
      route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }),
    );
    await gotoApp(page, `${base}/`);
    await openSettings(page);
    const row = page.locator('.identity-editable');
    await typeInto(row.locator('input'), 'Never Saved');
    await click(row.getByRole('button', { name: 'Save' }));
    await expect(page.locator('.identity-error-row .settings-error')).toHaveText(
      'Save failed (404)',
    );
  });

  test('updates: toggle and dismiss stay local', async ({ request, app }) => {
    const base = app.baseURL;
    const off = await api(request, base, '/api/update-check-enabled', { enabled: false });
    expect(off.status).toBe(200);
    expect((await getSettings(request, base)).updateCheck).toBe(false);
    const info = (await api<UpdateInfo>(request, base, '/api/update')).json;
    expect(info.enabled).toBe(false);
    // Nothing was ever fetched: no latest version, no check timestamp.
    expect(info.latest).toBeUndefined();
    expect(info.lastCheckedAt).toBeUndefined();
    expect((await api(request, base, '/api/update-check-enabled', { enabled: 'yes' })).status).toBe(
      400,
    );

    const dismissed = await api<UpdateInfo>(request, base, '/api/update/dismiss', {
      version: '99.0.0',
    });
    expect(dismissed.status).toBe(200);
    expect(dismissed.json.dismissedVersion).toBe('99.0.0');
    expect((await api(request, base, '/api/update/dismiss', { version: '' })).status).toBe(400);
    expect(((await getState(request, base)).updateInfo as UpdateInfo).dismissedVersion).toBe(
      '99.0.0',
    );

    await api(request, base, '/api/update-check-enabled', { enabled: true });
    expect((await api<UpdateInfo>(request, base, '/api/update')).json.enabled).toBe(true);
  });

  test('diagnostics: review notice first, commands redacted on request', async ({
    request,
    app,
  }) => {
    const base = app.baseURL;
    // Its own command widget (293S side key), so this does not depend on another spec.
    const secret = 'echo e2e-diagnostics-secret';
    await useDevice(request, base, 'mirabox-293s');
    const set = await api(request, base, '/api/extra-key', {
      wireId: 16,
      widget: 'command',
      param: secret,
      intervalMs: 3_600_000,
    });
    expect(set.status).toBe(200);
    await useDevice(request, base, DEFAULT_DEVICE);

    const full = await request.get(`${base}/api/diagnostics`);
    expect(full.headers()['content-type']).toContain('text/plain');
    const text = await full.text();
    expect(text.split('\n')[0]).toMatch(/^!! This report includes your settings/);
    expect(text).toContain(secret);

    const redacted = await (await request.get(`${base}/api/diagnostics?redactCommands=1`)).text();
    expect(redacted.split('\n')[0]).toMatch(/^!! This report includes your settings/);
    expect(redacted).not.toContain(secret);
    expect(redacted).toContain('<redacted>');
  });

  test('import / export settings.json', async ({ page, request, app }) => {
    const base = app.baseURL;
    await api(request, base, '/api/multi-deck', { enabled: false });

    // Export → modify → import round-trips a per-device value.
    const exported = await getSettings(request, base);
    const devices = (exported.devices ?? []).map((d) =>
      d.deviceKey === KEY ? { ...d, brightness: 42 } : d,
    );
    const imported = await api<{ ok: boolean; settings: SettingsJson }>(
      request,
      base,
      '/api/settings',
      { ...exported, devices },
    );
    expect(imported.status).toBe(200);
    expect(imported.json.settings.devices?.find((d) => d.deviceKey === KEY)?.brightness).toBe(42);
    // The selected dock's brightness is re-applied live.
    await expect.poll(async () => dock0(await getState(request, base)).brightness).toBe(42);

    // Malformed JSON and non-objects are refused and change nothing.
    for (const body of ['{"devices": [', '[]', '"x"']) {
      const res = await request.post(`${base}/api/settings`, {
        data: body,
        headers: { 'content-type': 'application/json' },
      });
      expect(res.status(), body).toBe(400);
    }
    expect((await deviceEntry(request, base, KEY))?.brightness).toBe(42);

    // An import that turns multi-deck on raises the cap and shows in the toggle.
    const multi = await api(request, base, '/api/settings', { multiDeck: true });
    expect(multi.status).toBe(200);
    expect((await getState(request, base)).multiDeck).toBe(true);
    await gotoApp(page, `${base}/`);
    await openSettings(page);
    await expect(page.locator('#toggle-multi-deck')).toBeChecked();
    // The saved-settings preview shows the file as the server has it.
    await expect(page.locator('.settings-json-preview')).toContainText('"multiDeck": true');

    await api(request, base, '/api/brightness', { level: 100 });
  });

  test('log level validates and /api/state follows', async ({ request, app }) => {
    const base = app.baseURL;
    for (const level of ['warn', 'debug', 'info']) {
      expect((await api(request, base, '/api/log-level', { level })).status).toBe(200);
      expect((await getState(request, base)).logLevel).toBe(level);
    }
    expect((await getSettings(request, base)).logLevel).toBe('info');
    expect((await api(request, base, '/api/log-level', { level: 'loud' })).status).toBe(400);
    expect((await getState(request, base)).logLevel).toBe('info');
  });

  test('/requirements page renders every check', async ({ page, request, app }) => {
    const base = app.baseURL;
    const res = await api<Array<{ name: string; ok: boolean; message: string }>>(
      request,
      base,
      '/api/requirements',
    );
    expect(res.status).toBe(200);
    const names = res.json.map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['deckbridge_native', 'libhidapi']));
    // The native lib the suite booted with is found.
    expect(res.json.find((r) => r.name === 'deckbridge_native')?.ok).toBe(true);

    await gotoApp(page, `${base}/requirements`);
    await expect(page.locator('h1')).toHaveText('System Requirements');
    await expect(page.locator('#root tbody tr')).toHaveCount(res.json.length);
    await expect(page.locator('#root .summary')).toHaveCount(1);
  });
});
