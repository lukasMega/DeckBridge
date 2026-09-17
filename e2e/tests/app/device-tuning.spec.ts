import { click, usingChromium } from '../../helpers/click.js';
import { expect, test } from '../../fixtures/app.js';

/** Wait until the mock driver is connected again. A 'reopen' change really does
 *  drop and re-open the session (mDNS advert included), and the app server is
 *  shared with every later spec, so no test may leave it mid-reconnect. */
async function waitForDriver(
  request: import('@playwright/test').APIRequestContext,
  baseURL: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const res = await request.get(`${baseURL}/api/state`);
        return ((await res.json()) as { driverConnected?: boolean }).driverConnected === true;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
}

/** POST an override straight at the API and report how the server applied it.
 *  Driven through Playwright's own request context rather than in-page `fetch`:
 *  a long series of page-side fetches leaves the Lightpanda session unable to
 *  navigate again, which wedges whichever spec runs next. */
async function postOverride(
  request: import('@playwright/test').APIRequestContext,
  baseURL: string,
  body: Record<string, unknown>,
  path = '/api/device-overrides',
): Promise<{ status: number; reconnecting?: boolean; error?: string }> {
  const res = await request.post(`${baseURL}${path}`, { data: body });
  const parsed = (await res.json()) as { reconnecting?: boolean; error?: string };
  return { status: res.status(), ...parsed };
}

/** GET /api/device-overrides for the currently selected dock. */
async function overridesView(
  request: import('@playwright/test').APIRequestContext,
  baseURL: string,
): Promise<{ modelId: string; effective: { image: { rotate: number } } }> {
  const res = await request.get(`${baseURL}/api/device-overrides`);
  return (await res.json()) as { modelId: string; effective: { image: { rotate: number } } };
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
    await page.goto(`${app.baseURL}/`);
    await click(page.locator('#settingsBtn'));

    // The collapsible renders its body whether or not it is expanded, and
    // Lightpanda has no layout — so the controls are reachable without the
    // header click (which needs a real pointer to toggle).
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
