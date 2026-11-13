import type { Page } from '@playwright/test';
import { click, usingChromium } from '../../helpers/click.js';
import { gotoApp } from '../../helpers/goto.js';
import {
  api,
  DEFAULT_DEVICE,
  expect,
  getSettings,
  restoreSettings,
  test,
  useDevice,
  waitForState,
  type SettingsJson,
} from '../../fixtures/app.js';

// Untested and sidecar, so the wizard is offered (mk2, the default, is neither).
const MODEL = 'ajazz-akp153';

interface Spec {
  rows: number;
  columns: number;
  frameOrientation: { rotate: number; flipH: boolean };
  image: { rotate: number; width: number };
  coraToWireImage: number[];
  hasAppFrames: boolean;
}

/** Answer one wizard question (verify-modal.tsx `ask`: radio `verify-q-<id>`, value = pick). */
async function pick(page: Page, id: string, value: string): Promise<void> {
  // Click waits for the step's fieldset to leave its busy (disabled) state.
  await click(page.locator(`#verify-wizard input[name="verify-q-${id}"][value="${value}"]`));
}

/** Pick an answer that keeps the same question on screen and wait for its repaint. */
async function pickAndRepaint(page: Page, id: string, value: string): Promise<void> {
  const painted = page.waitForResponse((r) => r.url().endsWith('/api/verify/paint'));
  await pick(page, id, value);
  expect((await painted).status()).toBe(200);
}

test.describe('device verify wizard (mock AKP153)', () => {
  // D14 in .claude/plans/2026-10-21_device-verify-wizard.md.
  test.skip(
    !usingChromium,
    "Lightpanda's toDataURL('image/jpeg') returns PNG, so the wizard draws no test images; run with E2E_BROWSER=chromium",
  );

  let snapshot: SettingsJson;

  test.beforeAll(async ({ app, workerRequest }) => {
    snapshot = await getSettings(workerRequest, app.baseURL);
    await useDevice(workerRequest, app.baseURL, MODEL);
  });

  test.afterAll(async ({ app, workerRequest }) => {
    const res = await api(workerRequest, app.baseURL, '/api/settings', {
      verifyDismissed: snapshot.verifyDismissed ?? [],
    });
    expect(res.status, 'restore verifyDismissed').toBe(200);
    await useDevice(workerRequest, app.baseURL, DEFAULT_DEVICE);
    await restoreSettings(workerRequest, app.baseURL, snapshot);
  });

  test('the offer walks every step and saves the override', async ({ page, request, app }) => {
    const base = app.baseURL;
    const before = await api<{ ok: boolean; spec: Spec }>(request, base, '/api/verify/spec?dock=0');
    expect(before.json.ok, 'the wizard is available for an untested sidecar deck').toBe(true);
    const spec = before.json.spec;
    // The expected override below is derived from these registry values.
    expect(spec).toMatchObject({
      rows: 3,
      columns: 5,
      frameOrientation: { rotate: 180, flipH: false },
      image: { rotate: 90, width: 85 },
      hasAppFrames: false,
    });

    await gotoApp(page, `${base}/`);
    await click(page.locator('#verify-offer-start-0'));
    const wizard = page.locator('#verify-wizard');
    await expect(wizard.locator('#verify-title')).toHaveText('Check your deck');
    await click(wizard.locator('#verify-start'));

    await pick(page, 'visible', 'all');
    await expect(wizard.locator('img.verify-thumb')).toHaveCount(8);
    // The deck shows the glyph turned 90° CW: T' = 90 ∘ 180 ∘ 270 ∘ 180 = 0.
    await pick(page, 'orient', '90');
    await pick(page, 'upright', 'yes');
    await pick(page, 'colours', 'rgb');
    // Candidate 1 = rows reversed.
    await pick(page, 'order', '1');
    await pick(page, 'ordered', 'yes');
    // 85 → outer ring cut → 80 fits.
    await pickAndRepaint(page, 'size', 'cut');
    await pick(page, 'size', 'fits');

    const saved = page.waitForResponse((r) => r.url().endsWith('/api/verify/save'));
    await pick(page, 'confirm', 'yes');
    expect((await saved).status()).toBe(200);
    // Mock has no app frames: the real-image check is skipped, dock 0 asks about buttons.
    await pick(page, 'buttons', 'skip');
    await expect(wizard.locator('h3.survey-q')).toHaveText('Saved');
    await expect(wizard.locator('#verify-copy')).toBeEnabled();
    await expect(wizard.locator('#verify-cancel')).toHaveText('Done');
    await click(wizard.locator('#verify-cancel'));
    await expect(wizard).toHaveCount(0);

    // keyMap is a 'reopen' change: let the mock reconnect before reading it back.
    await waitForState(request, base, (s) => s.driverConnected && s.modelId === MODEL);
    const { rows, columns } = spec;
    const rowsReversed = Array.from(
      { length: rows * columns },
      (_, p) =>
        spec.coraToWireImage[(rows - 1 - Math.floor(p / columns)) * columns + (p % columns)],
    );
    const expected = {
      image: { rotate: 0, width: 80, height: 80 },
      keyMap: { coraToWireImage: rowsReversed },
      splash: { transformOverride: { rotate: 180, flipH: false, flipV: false } },
    };
    const settings = await getSettings(request, base);
    expect(settings.modelOverrides?.[MODEL]).toEqual(expected);
    expect(settings.verifyDismissed).toContain(MODEL);
    const view = await api<{ overrides: unknown }>(
      request,
      base,
      `/api/device-overrides?modelId=${MODEL}`,
    );
    expect(view.json.overrides).toEqual(expected);
    // A saved model is never offered again.
    await expect(page.locator('#verify-offer-0')).toHaveCount(0);
  });

  test('cancel from device tuning ends the session and frees the deck', async ({
    page,
    request,
    app,
  }) => {
    const base = app.baseURL;
    await gotoApp(page, `${base}/`);
    await click(page.locator('#settingsBtn'));
    await click(page.locator('#device-tuning > .collapse-header'));
    await click(page.locator('#tuning-verify'));
    const wizard = page.locator('#verify-wizard');
    await click(wizard.locator('#verify-start'));
    await expect(wizard.locator('input[name="verify-q-visible"]').first()).toBeAttached();

    // The open wizard holds the deck.
    const held = await api<{ reason?: string }>(request, base, '/api/verify/start', {
      dockIndex: 0,
    });
    expect(held.status).toBe(409);
    expect(held.json.reason).toBe('busy');

    const ended = page.waitForRequest((r) => r.url().endsWith('/api/verify/end'));
    await click(wizard.locator('#verify-cancel'));
    await expect(wizard).toHaveCount(0);
    await ended;

    // Released by end, not by the 30 s lease expiry.
    let token = '';
    await expect
      .poll(
        async () => {
          const r = await api<{ token?: string }>(request, base, '/api/verify/start', {
            dockIndex: 0,
          });
          token = r.json.token ?? '';
          return r.status;
        },
        { timeout: 5_000 },
      )
      .toBe(200);
    expect((await api(request, base, '/api/verify/end', { token })).status).toBe(200);
  });
});
