import { selectValue } from '../../helpers/click.js';
import { gotoApp } from '../../helpers/goto.js';
import {
  api,
  connectElgato,
  DEFAULT_DEVICE,
  device,
  deviceEntry,
  dock0,
  expect,
  getState,
  PLAIN_DEVICES,
  test,
  useDevice,
  waitForState,
  type ElgatoClient,
} from '../../fixtures/app.js';

/** Drive the brightness fader the way a drag ends: `input` (debounced POST) then `change`. */
async function dragBrightness(page: import('@playwright/test').Page, level: number): Promise<void> {
  await page.locator('#simple-brightness').evaluate((el, v) => {
    const input = el as HTMLInputElement;
    input.value = String(v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, level);
}

// A fake Elgato child connection is what makes the stage "Everything's working"; the
// hero flip itself is covered by paired.spec.ts.
test.describe('Ready stage (paired via a fake CORA client)', () => {
  let elgato: ElgatoClient | undefined;

  test.beforeAll(async ({ app, workerRequest }) => {
    await useDevice(workerRequest, app.baseURL, DEFAULT_DEVICE);
    elgato = await connectElgato(workerRequest, app.baseURL);
  });

  test.afterAll(async ({ app, workerRequest }) => {
    await elgato?.close();
    await useDevice(workerRequest, app.baseURL, DEFAULT_DEVICE);
    await api(workerRequest, app.baseURL, '/api/brightness-override', { enabled: true });
    await api(workerRequest, app.baseURL, '/api/brightness', { level: 100 });
  });

  test('brightness: the slider posts, the level persists, the source toggle round-trips', async ({
    page,
    request,
    app,
  }) => {
    const base = app.baseURL;
    await api(request, base, '/api/brightness-override', { enabled: true });
    await gotoApp(page, `${base}/`);
    await expect(page.locator('#stage .hero h1')).toHaveText("Everything's working");

    const slider = page.locator('#simple-brightness');
    await expect(slider).toBeEnabled();
    const posted = page.waitForRequest(
      (r) => r.url().endsWith('/api/brightness') && r.method() === 'POST',
    );
    await dragBrightness(page, 37);
    expect((await posted).postDataJSON()).toEqual({ level: 37, dock: 0 });
    await expect(page.locator('#simple-brightness-val')).toHaveText('37%');

    // Persisted per device (settings.json via syncDockBrightness) and in the live status.
    await waitForState(request, base, (s) => s.brightness === 37 && dock0(s).brightness === 37);
    await expect
      .poll(async () => (await deviceEntry(request, base, `mock:${DEFAULT_DEVICE}`))?.brightness)
      .toBe(37);

    // Source toggle: the UI posts it, and an API change is pushed back to the page over WS.
    const override = page.waitForRequest((r) => r.url().endsWith('/api/brightness-override'));
    await selectValue(page.locator('.b-mode-select'), 'control');
    expect((await override).postDataJSON()).toEqual({ enabled: false });
    await expect(slider).toBeDisabled();
    await expect.poll(async () => (await getState(request, base)).brightnessOverride).toBe(false);

    await api(request, base, '/api/brightness-override', { enabled: true });
    await expect(page.locator('.b-mode-select')).toHaveValue('ignore');
    await expect(slider).toBeEnabled();

    // An out-of-range level is refused before it reaches the device.
    expect((await api(request, base, '/api/brightness', { level: 101 })).status).toBe(400);
  });

  test('side keys, strip and knobs render only on devices that have them', async ({
    page,
    request,
    app,
  }) => {
    const base = app.baseURL;
    await gotoApp(page, `${base}/`);
    const stage = page.locator('#stage');
    const sideKeys = stage.locator('.xkey-card');
    const strip = stage.getByRole('list', { name: 'Touch strip zones' });
    const knobs = stage.locator('.xkeys-knobs');

    // Plain boards: the Ready stage is the grid + brightness, nothing else.
    for (const d of PLAIN_DEVICES) {
      await useDevice(request, base, d.id);
      await expect(stage.locator('.key-grid')).toHaveAttribute('data-model', d.id);
      await expect(stage.locator('.hero h1')).toHaveText("Everything's working");
      await expect(stage.locator('.key-grid button[data-key]')).toHaveCount(d.keyCount);
      await expect(page.locator('#simple-brightness')).toHaveCount(1);
      await expect(sideKeys).toHaveCount(0);
      await expect(strip).toHaveCount(0);
      await expect(knobs).toHaveCount(0);
      await expect(stage.locator('.xkeys')).toHaveCount(0);
    }

    // 6th-column boards: three display-only side keys, no strip, no knobs.
    for (const id of ['mirabox-293s', 'ajazz-akp153']) {
      await useDevice(request, base, id);
      await expect(stage.locator('.key-grid')).toHaveAttribute('data-model', id);
      await expect(sideKeys).toHaveCount(3);
      await expect(stage.locator('.xkey-pos')).toHaveText(['Top', 'Middle', 'Bottom']);
      await expect(stage.getByRole('group', { name: 'Side keys' })).toHaveCount(1);
      await expect(stage.getByRole('group', { name: 'Touch strip' })).toHaveCount(0);
      await expect(strip).toHaveCount(0);
      await expect(knobs).toHaveCount(0);
    }

    // AKP05E (native 5×2): strip zones + knobs, and no side keys until it re-pairs as a
    // Stream Deck + (touch-strip-knobs.spec.ts).
    const akp05e = device('ajazz-akp05e');
    await useDevice(request, base, akp05e.id);
    await expect(stage.locator('.key-grid')).toHaveAttribute('data-model', akp05e.id);
    await expect(strip.getByRole('listitem')).toHaveCount(akp05e.stripZones!.length);
    await expect(knobs).toHaveCount(1);
    await expect(sideKeys).toHaveCount(0);

    // Back to a plain board: nothing stale from the previous model.
    await useDevice(request, base, DEFAULT_DEVICE);
    await expect(stage.locator('.key-grid')).toHaveAttribute('data-model', DEFAULT_DEVICE);
    await expect(strip).toHaveCount(0);
    await expect(knobs).toHaveCount(0);
    // The fake client survived every model switch.
    expect((await getState(request, base)).elgatoConnected).toBe(true);
  });
});
