import { click, usingChromium } from '../../helpers/click.js';
import { gotoApp } from '../../helpers/goto.js';
import { api, expect, test, waitForDriver } from '../../fixtures/app.js';

type Request = import('@playwright/test').APIRequestContext;

/** POST an override straight at the API and report how the server applied it. */
async function postOverride(
  request: Request,
  baseURL: string,
  body: Record<string, unknown>,
  path = '/api/device-overrides',
): Promise<{ status: number; reconnecting?: boolean; error?: string }> {
  const res = await api<{ reconnecting?: boolean; error?: string }>(request, baseURL, path, body);
  return { status: res.status, ...res.json };
}

type OverridesView = { modelId: string; effective: { image: { rotate: number } } };

/** GET /api/device-overrides for the currently selected dock. */
async function overridesView(request: Request, baseURL: string): Promise<OverridesView> {
  return (await api<OverridesView>(request, baseURL, '/api/device-overrides')).json;
}

test.describe('device tuning applies without a reconnect', () => {
  // No browser page: this is the HTTP contract, and every extra Lightpanda page
  // load is a chance for the next spec's navigation to time out.
  test('an image-only change is applied live; keyMap/wire still reconnect', async ({
    request,
    app,
  }) => {
    const { modelId } = await overridesView(request, app.baseURL);

    // Image section only → swapped into the live session, no reopen.
    const live = await postOverride(request, app.baseURL, {
      modelId,
      overrides: { image: { rotate: 90 } },
    });
    expect(live.status).toBe(200);
    expect(live.reconnecting).toBe(false);

    // The change really is in force on the running session, not merely persisted.
    expect((await overridesView(request, app.baseURL)).effective.image.rotate).toBe(90);

    // Same value again → nothing to do, and still no reconnect.
    const repeat = await postOverride(request, app.baseURL, {
      modelId,
      overrides: { image: { rotate: 90 } },
    });
    expect(repeat.reconnecting).toBe(false);

    // keyMap is read by the driver at open(), so this one must reopen the session.
    const reopen = await postOverride(request, app.baseURL, {
      modelId,
      overrides: { image: { rotate: 90 }, keyMap: { imageOffset: 1 } },
    });
    expect(reopen.reconnecting).toBe(true);

    // Reset drops the keyMap too → reopen again, back to the registry defaults.
    const reset = await postOverride(
      request,
      app.baseURL,
      { modelId },
      '/api/device-overrides/reset',
    );
    expect(reset.status).toBe(200);
    expect(reset.reconnecting).toBe(true);
    await waitForDriver(request, app.baseURL);
  });

  // Chromium-only (E2E_BROWSER=chromium). The panel's Apply issues a page-side
  // POST, after which Lightpanda reproducibly stalls one later navigation for
  // 5 s — with the app server verified responsive throughout, so it is the
  // runtime, not the product. The same wording is asserted headlessly by
  // ts/scripts/test-client.mjs, and the API test above covers the behaviour.
  test('Apply in the tuning panel reports a live apply, not a reconnect', async ({
    page,
    request,
    app,
  }) => {
    test.skip(!usingChromium, 'page-side POST wedges a later Lightpanda navigation');
    await gotoApp(page, `${app.baseURL}/`);
    await click(page.locator('#settingsBtn'));

    await click(page.locator('#device-tuning > .collapse-header'));
    await expect(page.locator('#device-tuning-body .tuning-grid').first()).toBeAttached();

    // Rotation is an image field, so Apply must not announce a reconnect.
    // ROTATIONS order is 0/90/180/270 — index 2 is the 180° radio. (Preact sets
    // `value` as a property, so an attribute selector would not match it.)
    await page
      .locator('#device-tuning input[name="rotation"]')
      .nth(2)
      .evaluate((el) => {
        (el as HTMLInputElement).click();
      });

    await click(page.locator('#tuning-apply'));

    // The panel prints the live-apply wording only when the server answered
    // `reconnecting: false` (device-tuning.tsx), so this is the round trip.
    await expect(page.locator('#device-tuning .settings-status')).toHaveText(
      'Applied to the device.',
    );

    // Leave the instance as we found it — the app server is shared by the worker.
    await postOverride(
      request,
      app.baseURL,
      { modelId: (await overridesView(request, app.baseURL)).modelId },
      '/api/device-overrides/reset',
    );
    await waitForDriver(request, app.baseURL);
  });
});
