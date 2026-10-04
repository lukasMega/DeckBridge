import { selectValue } from '../../helpers/click.js';
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
  PLUS_PROFILE,
  resetOverride,
  restoreSettings,
  test,
  useDevice,
  waitForState,
  type ElgatoClient,
  type SettingsJson,
} from '../../fixtures/app.js';

/** Re-run interval long enough that only the first paint and explicit refreshes run it. */
const NO_REPEAT_MS = 3_600_000;

test.describe('side keys (293S, AKP153 rev. 1, AKP05E as a Stream Deck +)', () => {
  let elgato: ElgatoClient | undefined;
  let snapshot: SettingsJson;
  const marker = new Marker();

  test.beforeAll(async ({ app, workerRequest }) => {
    snapshot = await getSettings(workerRequest, app.baseURL);
    elgato = await connectElgato(workerRequest, app.baseURL, app.childPort);
  });

  test.afterAll(async ({ app, workerRequest }) => {
    await useDevice(workerRequest, app.baseURL, DEFAULT_DEVICE);
    await resetOverride(workerRequest, app.baseURL, 'ajazz-akp05e');
    await restoreSettings(workerRequest, app.baseURL, snapshot);
    await elgato?.close();
    marker.dispose();
  });

  test('293S: assign, style, run and preview the display-only column', async ({
    page,
    request,
    app,
  }) => {
    const base = app.baseURL;
    const key = `mock:mirabox-293s`;
    await useDevice(request, base, 'mirabox-293s');
    await gotoApp(page, `${base}/`);
    const cards = page.locator('#stage .xkey-card');
    await expect(cards).toHaveCount(3);
    const top = page.getByRole('group', { name: 'Top side key' });

    // Assign from the UI: the select posts, the server persists under this device.
    const posted = page.waitForRequest((r) => r.url().endsWith('/api/extra-key'));
    await selectValue(top.getByLabel('Top side key widget'), 'clock');
    expect((await posted).postDataJSON()).toMatchObject({ wireId: 16, widget: 'clock' });
    await expect
      .poll(async () => (await deviceEntry(request, base, key))?.extraKeys?.['16'])
      .toEqual({ widget: 'clock' });
    // The server paints it, and the painted image comes back to the tile over WS.
    await expect(top.locator('.xkey-tile img')).toHaveCount(1);

    // Text style persists compacted: defaults dropped, colours lower-cased.
    const styled = await api(request, base, '/api/extra-key', {
      wireId: 17,
      widget: 'text',
      param: 'hello',
      style: { bold: true, padding: 0, align: 'center', outline: '#FF0000' },
    });
    expect(styled.status).toBe(200);
    expect((await deviceEntry(request, base, key))?.extraKeys?.['17']).toEqual({
      widget: 'text',
      param: 'hello',
      style: { bold: true, outline: '#ff0000' },
    });
    await expect(page.getByLabel('Middle side key widget')).toHaveValue('text');
    const badStyle = await api(request, base, '/api/extra-key', {
      wireId: 17,
      widget: 'text',
      style: { padding: 99 },
    });
    expect(badStyle.status).toBe(400);

    // No switch in this column: a press command is refused, and so is a mock press.
    const press = await api(request, base, '/api/extra-key/press', { wireId: 16, command: 'x' });
    expect(press.status).toBe(400);
    expect((await api(request, base, '/api/mock/extra-key/16', {})).status).toBe(400);
    // Not a side key of this dock at all.
    expect(
      (await api(request, base, '/api/extra-key', { wireId: 15, widget: 'clock' })).status,
    ).toBe(400);

    // Preview: nothing painted on 18 yet → 404.
    expect((await api(request, base, '/api/extra-key/preview', { wireId: 18 })).status).toBe(404);

    // "Run now": refused on a non-command widget, re-runs a command widget.
    expect((await api(request, base, '/api/extra-key/run', { wireId: 16 })).status).toBe(400);
    const cmd = await api(request, base, '/api/extra-key', {
      wireId: 18,
      widget: 'command',
      param: marker.command('widget'),
      intervalMs: NO_REPEAT_MS,
    });
    expect(cmd.status).toBe(200);
    await marker.waitForCount(1, 'first run of the command widget');
    const before = marker.count();
    expect((await api(request, base, '/api/extra-key/run', { wireId: 18 })).status).toBe(200);
    await marker.waitForCount(before + 1, '"Run now" re-ran the command');

    // Preview after the first paint: one thumbnail per text size.
    await expect
      .poll(async () => (await api(request, base, '/api/extra-key/preview', { wireId: 18 })).status)
      .toBe(200);
    const preview = await api<{ previews: unknown[] }>(request, base, '/api/extra-key/preview', {
      wireId: 18,
    });
    expect(preview.json.previews.length).toBeGreaterThan(1);
  });

  test('switching device swaps the panel, and each device keeps its own keys', async ({
    page,
    request,
    app,
  }) => {
    const base = app.baseURL;
    await useDevice(request, base, 'mirabox-293s');
    await api(request, base, '/api/extra-key', { wireId: 16, widget: 'date' });
    await gotoApp(page, `${base}/`);
    const topWidget = page.getByLabel('Top side key widget');
    await expect(topWidget).toHaveValue('date');

    // AKP153 rev. 1 is the same board under another identity: same cards, none of the config.
    await useDevice(request, base, 'ajazz-akp153');
    await expect(page.locator('#stage .key-grid')).toHaveAttribute('data-model', 'ajazz-akp153');
    await expect(page.locator('#stage .xkey-card')).toHaveCount(3);
    await expect(topWidget).toHaveValue('none');

    // A plain device drops the panel entirely.
    await useDevice(request, base, DEFAULT_DEVICE);
    await expect(page.locator('#stage .key-grid')).toHaveAttribute('data-model', DEFAULT_DEVICE);
    await expect(page.locator('#stage .xkey-card')).toHaveCount(0);

    await useDevice(request, base, 'mirabox-293s');
    await expect(topWidget).toHaveValue('date');
  });

  test('AKP05E as a Stream Deck +: the right column presses run commands and refreshes', async ({
    page,
    request,
    app,
  }) => {
    const base = app.baseURL;
    const id = 'ajazz-akp05e';
    await useDevice(request, base, id);
    const state = await waitForState(
      request,
      base,
      (s) => dock0(s).coraProfile === PLUS_PROFILE.advertiseAs,
    );
    expect(dock0(state).extraKeys).toEqual(PLUS_PROFILE.extraKeys);
    expect(dock0(state).pressableExtraKeys).toEqual(PLUS_PROFILE.extraKeys);

    await gotoApp(page, `${base}/`);
    await expect(page.locator('#stage .xkey-card')).toHaveCount(2);
    await expect(page.locator('#stage .xkey-pos')).toHaveText(['Top', 'Bottom']);
    // Keys with a switch get the "On press" controls.
    await expect(page.getByLabel('Top side key press action')).toHaveCount(1);

    // Press command: the mock press reaches the command runner.
    const setPress = await api(request, base, '/api/extra-key/press', {
      wireId: 15,
      command: marker.command('press15'),
      action: 'command',
    });
    expect(setPress.status).toBe(200);
    const action = await nextFrame(
      base,
      (f) => f.event === 'deviceAction' && String(f.data.message).includes('15 pressed'),
      () => api(request, base, '/api/mock/extra-key/15', {}),
    );
    expect(action.data.dockIndex).toBe(0);
    await expect.poll(() => marker.lines().filter((l) => l === 'press15').length).toBe(1);

    // Refresh action: a press re-runs the key's command widget instead.
    expect(
      (
        await api(request, base, '/api/extra-key', {
          wireId: 10,
          widget: 'command',
          param: marker.command('widget10'),
          intervalMs: NO_REPEAT_MS,
        })
      ).status,
    ).toBe(200);
    const runs = (): number => marker.lines().filter((l) => l === 'widget10').length;
    await expect.poll(runs).toBe(1);
    await api(request, base, '/api/extra-key/press', { wireId: 10, action: 'refresh' });
    expect((await api(request, base, '/api/mock/extra-key/10', {})).status).toBe(204);
    await expect.poll(runs).toBe(2);
    // A grid-only wire id is not a side key.
    expect((await api(request, base, '/api/mock/extra-key/11', {})).status).toBe(400);
  });
});
