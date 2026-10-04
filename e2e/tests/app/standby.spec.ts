import type { APIRequestContext } from '@playwright/test';
import { click } from '../../helpers/click.js';
import { gotoApp } from '../../helpers/goto.js';
import {
  api,
  connectElgato,
  DEFAULT_DEVICE,
  device,
  dock0,
  expect,
  getSettings,
  getState,
  PLUS_PROFILE,
  resetOverride,
  restoreSettings,
  test,
  useDevice,
  waitForState,
  type SettingsJson,
} from '../../fixtures/app.js';

// DECKBRIDGE_STANDBY_FAST=1 (helpers/app-server.ts): "minutes" are seconds, the app-gone
// debounce is 1 s, and CORA-silence detection is off (the fake client never speaks).
const AKP05E = device('ajazz-akp05e');
const ALL_OFF = {
  idleDim: false,
  offWhenIdle: false,
  appGoneAction: 'none',
  night: false,
  pixelShift: false,
};

/** Stream Deck + encoder-rotate report as the child server frames it (cora/plus-reports.ts). */
const PLUS_ROTATE_KNOB0 = Buffer.from([0x01, 0x03, 0x05, 0x00, 0x01, 0x01]);

async function setStandby(
  request: APIRequestContext,
  base: string,
  settings: Record<string, unknown>,
): Promise<void> {
  const res = await api(request, base, '/api/standby', { settings });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
}

test.describe('standby and burn-in care (mock, fast timing)', () => {
  let snapshot: SettingsJson;

  test.beforeAll(async ({ app, workerRequest }) => {
    snapshot = await getSettings(workerRequest, app.baseURL);
    await useDevice(workerRequest, app.baseURL, DEFAULT_DEVICE);
  });

  test.afterEach(async ({ request, app }) => {
    await setStandby(request, app.baseURL, ALL_OFF);
    await waitForState(request, app.baseURL, (s) => dock0(s).displayState === 'active');
  });

  test.afterAll(async ({ app, workerRequest }) => {
    await useDevice(workerRequest, app.baseURL, DEFAULT_DEVICE);
    await resetOverride(workerRequest, app.baseURL, AKP05E.id);
    await restoreSettings(workerRequest, app.baseURL, snapshot);
  });

  test('idle dim lowers the effective level only; a click wakes the deck', async ({
    request,
    app,
  }) => {
    const base = app.baseURL;
    await setStandby(request, base, { idleDim: true, idleMinutes: 1, idleLevel: 10 });
    const elgato = await connectElgato(request, base, app.childPort);
    try {
      const dimmed = dock0(
        await waitForState(request, base, (s) => dock0(s).displayState === 'dimmed'),
      );
      expect(dimmed.effectiveBrightness).toBe(10);
      expect(dimmed.brightness).toBeGreaterThan(10);

      // Click-to-press is never swallowed: it wakes the deck and reaches the app.
      await request.post(`${base}/api/key/0`);
      await waitForState(request, base, (s) => dock0(s).displayState === 'active');
    } finally {
      await elgato.close();
    }
  });

  test('the waking knob turn is swallowed, the next one reaches the app', async ({
    request,
    app,
  }) => {
    const base = app.baseURL;
    await useDevice(request, base, AKP05E.id);
    await api(request, base, '/api/encoders', { connectToApp: true });
    await waitForState(request, base, (s) => dock0(s).coraProfile === PLUS_PROFILE.advertiseAs);
    // Two seconds of idle, so the follow-up turn lands before the deck dims again.
    await setStandby(request, base, { idleDim: true, idleMinutes: 2, idleLevel: 10 });
    const elgato = await connectElgato(request, base, app.childPort);
    try {
      await waitForState(request, base, (s) => dock0(s).displayState === 'dimmed');
      const turn = () =>
        api(request, base, '/api/mock/dial', { index: 0, kind: 'rotate', delta: 1 });

      expect((await turn()).status).toBe(204);
      await waitForState(request, base, (s) => dock0(s).displayState === 'active');
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(elgato.received().includes(PLUS_ROTATE_KNOB0)).toBe(false);

      await turn();
      await expect.poll(() => elgato.received().includes(PLUS_ROTATE_KNOB0)).toBe(true);
    } finally {
      await elgato.close();
      await useDevice(request, base, DEFAULT_DEVICE);
    }
  });

  test('standby clock appears when the app leaves and goes when it returns', async ({
    request,
    app,
  }) => {
    const base = app.baseURL;
    await setStandby(request, base, { appGoneAction: 'clock', clockLevel: 15 });
    const first = await connectElgato(request, base, app.childPort);
    await first.close();
    const standby = dock0(
      await waitForState(request, base, (s) => dock0(s).displayState === 'standby', 3_000),
    );
    expect(standby.effectiveBrightness).toBe(15);

    const second = await connectElgato(request, base, app.childPort);
    try {
      await waitForState(request, base, (s) => dock0(s).displayState === 'active');
    } finally {
      await second.close();
    }
  });

  test('a reconnect blip never shows the standby clock', async ({ request, app }) => {
    const base = app.baseURL;
    await setStandby(request, base, { appGoneAction: 'clock' });
    const first = await connectElgato(request, base, app.childPort);
    await first.close();
    const second = await connectElgato(request, base, app.childPort);
    try {
      const seen = new Set<string>();
      for (let i = 0; i < 20; i++) {
        seen.add(dock0(await getState(request, base)).displayState ?? 'none');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect([...seen]).not.toContain('standby');
    } finally {
      await second.close();
    }
  });

  test('screen off after idle zeroes the panel but not the saved level; a click wakes it', async ({
    request,
    app,
  }) => {
    const base = app.baseURL;
    const before = dock0(await getState(request, base)).brightness;
    await setStandby(request, base, { offWhenIdle: true, offMinutes: 2 });
    const off = dock0(await waitForState(request, base, (s) => dock0(s).displayState === 'off'));
    expect(off.effectiveBrightness).toBe(0);
    expect(off.brightness).toBe(before);

    await request.post(`${base}/api/key/0`);
    const woke = dock0(
      await waitForState(request, base, (s) => dock0(s).displayState === 'active'),
    );
    expect(woke.brightness).toBe(before);
  });

  test('the Settings panel shows the live state and saves a change', async ({
    page,
    request,
    app,
  }) => {
    const base = app.baseURL;
    await gotoApp(page, `${base}/`);
    await click(page.locator('#settingsBtn'));
    await expect(page.locator('.help h1')).toHaveText('Settings');
    const header = page.locator('.collapse-header', { hasText: 'Standby & burn-in care' });
    await expect(header).toContainText('Active');
    await expect(page.locator('#standby-body')).toContainText('DeckBridge time now');

    const posted = page.waitForRequest(
      (r) => r.url().endsWith('/api/standby') && r.method() === 'POST',
    );
    await click(page.locator('#toggle-standby-pixel-shift'));
    const body = (await posted).postDataJSON() as { settings: { pixelShift: boolean } };
    expect(body.settings.pixelShift).toBe(true);
    await expect
      .poll(async () => {
        const view = await api<{ settings: { pixelShift: boolean } }>(
          request,
          base,
          '/api/standby',
        );
        return view.json.settings.pixelShift;
      })
      .toBe(true);
  });
});
