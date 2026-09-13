import { expect, test } from '../../fixtures/app.js';

test.describe('web UI boot', () => {
  test('serves the shell and mounts the Preact app', async ({ page, app }) => {
    const response = await page.goto(`${app.baseURL}/`, { waitUntil: 'load' });
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle('DeckBridge');

    // ui-entry.ts mounts only after GET /api/state resolves, and it has no catch: when
    // that request 403s or hangs, #simple-view stays empty forever and the user sees a
    // blank page. Asserting on mounted content is what makes that failure visible.
    await expect(page.locator('#simple-view .app')).toHaveCount(1);
    await expect(page.locator('#stage')).not.toBeEmpty();
    await expect(page.locator('.brand .wordmark')).toHaveText('DeckBridge');
  });

  test('/api/state reports a connected mock driver', async ({ page, app }) => {
    await page.goto(`${app.baseURL}/`);
    const state = await page.evaluate(async () => {
      const res = await fetch('/api/state');
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    });
    expect(state.status).toBe(200);
    expect(state.body.driverMode).toBe('mock');
    expect(state.body.driverConnected).toBe(true);
    // No CORA client in this suite, so the Elgato side must be reported as down.
    expect(state.body.elgatoConnected).toBe(false);
  });

  test('serves the client bundle and 404s unknown paths', async ({ page, app }) => {
    await page.goto(`${app.baseURL}/`);
    const probe = await page.evaluate(async () => {
      const js = await fetch('/ui.js');
      const missing = await fetch('/definitely-not-a-route');
      return {
        jsStatus: js.status,
        jsLength: (await js.text()).length,
        missingStatus: missing.status,
      };
    });
    expect(probe.jsStatus).toBe(200);
    expect(probe.jsLength).toBeGreaterThan(1000);
    expect(probe.missingStatus).toBe(404);
  });

  test('rejects a foreign Host header', async ({ request, app }) => {
    // web-request-guard.ts allows localhost/127.0.0.1/[::1] plus this machine's own LAN
    // IPv4s; everything else is a bare 403. This is the app's only network-facing guard.
    const res = await request.get(`${app.baseURL}/`, { headers: { Host: 'evil.example' } });
    expect(res.status()).toBe(403);
  });
});
