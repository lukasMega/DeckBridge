import type { APIRequestContext } from '@playwright/test';
import { click, selectValue } from '../../helpers/click.js';
import { gotoApp } from '../../helpers/goto.js';
import {
  api,
  connectElgato,
  DEFAULT_DEVICE,
  deviceEntry,
  dock0,
  expect,
  getSettings,
  Marker,
  nextFrame,
  restoreSettings,
  test,
  useDevice,
  waitForState,
  type SettingsJson,
} from '../../fixtures/app.js';

// The Ulanzi D200 is not in the device matrix (helpers/devices.ts): its info window is the
// only thing here that differs from the other mocked boards, so this spec owns it.
const D200 = 'ulanzi-d200';
const KEY = `mock:${D200}`;
const WIDE_WIRE = 13;
const FIRMWARE_MODES = [0, 1, 2, 200, 201, 202, 203];

interface WideKeyView {
  config: { content: string; clockMode: number; hourFormat: string; press: string };
  contents: string[];
  clockModes: number[];
  presses: string[];
}

async function wideKey(
  request: APIRequestContext,
  base: string,
  config?: Record<string, unknown>,
): Promise<{ status: number; json: WideKeyView & { error?: string } }> {
  return api<WideKeyView & { error?: string }>(
    request,
    base,
    '/api/wide-key',
    config === undefined ? undefined : { config },
  );
}

test.describe('Ulanzi D200 info window (mock)', () => {
  let snapshot: SettingsJson;
  const marker = new Marker();

  test.beforeAll(async ({ app, workerRequest }) => {
    snapshot = await getSettings(workerRequest, app.baseURL);
  });

  // Each test starts from "no wideKey entry": the import drops what the last one stored.
  test.afterEach(async ({ app, workerRequest }) => {
    await restoreSettings(workerRequest, app.baseURL, snapshot);
  });

  test.afterAll(async ({ app, workerRequest }) => {
    await useDevice(workerRequest, app.baseURL, DEFAULT_DEVICE);
    await restoreSettings(workerRequest, app.baseURL, snapshot);
    marker.dispose();
  });

  test('only the D200 has an info window; the default is today’s clock', async ({
    request,
    app,
  }) => {
    const base = app.baseURL;
    const state = await useDevice(request, base, D200);
    const dock = dock0(state);
    expect(dock.smallWindowModes).toEqual(FIRMWARE_MODES);
    expect(dock.wideKeyWire).toBe(WIDE_WIRE);
    // The window is no side key, and it has no switch until its press is DeckBridge's.
    expect(dock.extraKeys).toBeUndefined();
    expect(dock.pressableExtraKeys).toBeUndefined();

    const view = await wideKey(request, base);
    expect(view.status).toBe(200);
    expect(view.json.config).toEqual({
      content: 'clock',
      clockMode: 203,
      hourFormat: '24H',
      press: 'none',
    });
    expect(view.json.contents).toEqual(['clock', 'dial', 'stats', 'widget']);
    expect(view.json.clockModes).toEqual([200, 201, 202, 203]);
    expect(view.json.presses).toEqual(['elgato-13', 'elgato-14', 'deckbridge', 'none']);

    // Nothing is persisted until the user changes something.
    expect((await deviceEntry(request, base, KEY))?.wideKey).toBeUndefined();

    // A board without the window: no status fields, and the route refuses.
    const plain = dock0(await useDevice(request, base, DEFAULT_DEVICE));
    expect(plain.smallWindowModes).toBeUndefined();
    expect(plain.wideKeyWire).toBeUndefined();
    expect((await wideKey(request, base)).status).toBe(409);
  });

  test('settings are validated, persist per device and merge', async ({ request, app }) => {
    const base = app.baseURL;
    await useDevice(request, base, D200);

    const stats = await wideKey(request, base, { content: 'stats', statsPlugin: 'mystats.js' });
    expect(stats.status).toBe(200);
    expect(stats.json.config.content).toBe('stats');
    expect((await deviceEntry(request, base, KEY))?.wideKey).toEqual({
      content: 'stats',
      statsPlugin: 'mystats.js',
    });

    // Only the posted keys change; an empty plugin name goes back to the built-in source.
    const merged = await wideKey(request, base, { hourFormat: '12H', statsPlugin: '' });
    expect(merged.status).toBe(200);
    expect((await deviceEntry(request, base, KEY))?.wideKey).toEqual({
      content: 'stats',
      hourFormat: '12H',
    });

    // Bad values and variants the model does not list are refused, and nothing changes.
    for (const bad of [{ content: 'nope' }, { clockMode: 204 }, { press: 'elgato-15' }]) {
      expect((await wideKey(request, base, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await api(request, base, '/api/wide-key', {})).status).toBe(400);
    expect((await wideKey(request, base)).json.config.content).toBe('stats');
  });

  test('a DeckBridge press reaches the command; other routes drop the mock press', async ({
    request,
    app,
  }) => {
    const base = app.baseURL;
    await useDevice(request, base, D200);
    await wideKey(request, base, { content: 'clock', press: 'none' });

    // Dropped: no switch, so neither a press command nor a mock press is accepted.
    expect(
      (await api(request, base, '/api/extra-key/press', { wireId: WIDE_WIRE, command: 'x' }))
        .status,
    ).toBe(400);
    expect((await api(request, base, `/api/mock/extra-key/${WIDE_WIRE}`, {})).status).toBe(400);

    // Routed to an Elgato cell: the Elgato app gets it, DeckBridge's own action does not.
    await wideKey(request, base, { press: 'elgato-14' });
    expect((await api(request, base, `/api/mock/extra-key/${WIDE_WIRE}`, {})).status).toBe(400);

    // DeckBridge action: now the window has a switch and the press runs the command.
    expect((await wideKey(request, base, { press: 'deckbridge' })).status).toBe(200);
    const routed = await waitForState(
      request,
      base,
      (s) => dock0(s).pressableExtraKeys?.includes(WIDE_WIRE) ?? false,
    );
    expect(dock0(routed).pressableExtraKeys).toEqual([WIDE_WIRE]);
    const set = await api(request, base, '/api/extra-key/press', {
      wireId: WIDE_WIRE,
      command: marker.command('wide'),
      action: 'command',
    });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    const action = await nextFrame(
      base,
      (f) => f.event === 'deviceAction' && String(f.data.message).includes(`${WIDE_WIRE} pressed`),
      () => api(request, base, `/api/mock/extra-key/${WIDE_WIRE}`, {}),
    );
    expect(action.data.dockIndex).toBe(0);
    await expect.poll(() => marker.lines().filter((l) => l === 'wide').length).toBe(1);

    // The widget is device-level: it lives in the device's own map, not a page layout.
    expect((await deviceEntry(request, base, KEY))?.extraKeys?.[String(WIDE_WIRE)]).toMatchObject({
      pressCommand: marker.command('wide'),
    });
  });

  test('the Info window sits on the main page with a live tile and round-trips its selects', async ({
    page,
    request,
    app,
  }) => {
    const base = app.baseURL;
    await useDevice(request, base, DEFAULT_DEVICE);
    // The deck card (and so the Info window) shows once the Elgato app is connected.
    const elgato = await connectElgato(request, base, app.childPort);
    try {
      await gotoApp(page, `${base}/`);
      const section = page.locator('#stage [aria-label="Info window"]');
      const tile = section.locator('[aria-label="Info window preview"]');
      // A plain board has no such section.
      await expect(page.locator('#stage .key-grid')).not.toHaveCount(0);
      await expect(section).toHaveCount(0);

      // The section follows the selected dock live: switching to the D200 mounts it.
      await useDevice(request, base, D200);
      await expect(section).toHaveCount(1);

      // The selects offer what the model lists, starting from the default.
      const content = page.locator('#wide-key-content');
      await expect(content).toHaveValue('clock');
      await expect(content.locator('option')).toHaveText(['Clock', 'Dial', 'Stats', 'Widget']);
      await expect(page.locator('#wide-key-hour-format')).toHaveValue('24H');
      await expect(page.locator('#wide-key-press')).toHaveValue('none');
      await expect(page.locator('#wide-key-stats-source')).toHaveCount(0);
      await expect(tile).toHaveText(/^\d{2}:\d{2}:\d{2}$/);

      // Hours: the tile follows, and the one changed key is posted.
      const hoursPosted = page.waitForRequest((r) => r.url().endsWith('/api/wide-key'));
      await selectValue(page.locator('#wide-key-hour-format'), '12H');
      expect((await hoursPosted).postDataJSON()).toEqual({ config: { hourFormat: '12H' } });
      await expect(tile).toHaveText(/^\d{1,2}:\d{2}:\d{2} (?:AM|PM)$/);

      // Content: posts the one changed key, shows the stats-only control and live figures.
      const posted = page.waitForRequest((r) => r.url().endsWith('/api/wide-key'));
      await selectValue(content, 'stats');
      expect((await posted).postDataJSON()).toEqual({ config: { content: 'stats' } });
      await expect(page.locator('#wide-key-stats-source')).toHaveCount(1);
      await expect(page.locator('#wide-key-hour-format')).toHaveCount(0);
      await expect(tile).toHaveText(/CPU \d+%MEM \d+%/);
      await expect
        .poll(async () => (await deviceEntry(request, base, KEY))?.wideKey)
        .toEqual({ hourFormat: '12H', content: 'stats' });

      // Press: another select, same route.
      const pressPosted = page.waitForRequest((r) => r.url().endsWith('/api/wide-key'));
      await selectValue(page.locator('#wide-key-press'), 'elgato-13');
      expect((await pressPosted).postDataJSON()).toEqual({ config: { press: 'elgato-13' } });
      await expect
        .poll(async () => (await deviceEntry(request, base, KEY))?.wideKey)
        .toEqual({ hourFormat: '12H', content: 'stats', press: 'elgato-13' });

      // Widget: the painted image is the only tile, and the window rows join its card.
      await selectValue(content, 'widget');
      await expect(tile).toHaveCount(0);
      await expect(section.locator('.xkey-tile')).toHaveCount(1);
      await expect(section.getByRole('group', { name: 'Widget side key' })).toHaveCount(1);
      await selectValue(content, 'stats');

      // A fresh load reads the stored choice back from the server.
      await gotoApp(page, `${base}/`);
      await expect(page.locator('#wide-key-content')).toHaveValue('stats');
      await expect(page.locator('#wide-key-press')).toHaveValue('elgato-13');

      // Settings no longer carries it.
      await click(page.locator('#settingsBtn'));
      await expect(page.locator('.help h1')).toHaveText('Settings');
      await expect(page.locator('[aria-label="Info window"]')).toHaveCount(0);
      await expect(page.locator('#wide-key-content')).toHaveCount(0);
    } finally {
      await elgato.close();
    }
  });
});
