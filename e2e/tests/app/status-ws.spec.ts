import { expect, test } from '../../fixtures/app.js';

test.describe('live status channel', () => {
  test('/api/ws pushes a status snapshot on connect', async ({ page, app }) => {
    await page.goto(`${app.baseURL}/`);

    const first = await page.evaluate(
      () =>
        new Promise<string>((resolve, reject) => {
          const ws = new WebSocket(`ws://${location.host}/api/ws`);
          const timer = setTimeout(() => reject(new Error('no frame within 10s')), 10_000);
          ws.addEventListener('message', (ev) => {
            clearTimeout(timer);
            ws.close();
            resolve(String(ev.data));
          });
          ws.addEventListener('error', () => {
            clearTimeout(timer);
            reject(new Error('websocket error'));
          });
        }),
    );

    // Wire format is always {event, data} (broadcaster.ts), and the very first frame a
    // client receives is the full snapshot.
    const frame = JSON.parse(first) as { event: string; data: Record<string, unknown> };
    expect(frame.event).toBe('status');
    expect(frame.data.driverMode).toBe('mock');
    expect(frame.data.driverConnected).toBe(true);
  });

  test('a simulated key press round-trips HTTP → driver → WS', async ({ page, app }) => {
    await page.goto(`${app.baseURL}/`);

    // POST /api/key/:n is mock-only (409 otherwise). It reaches the driver, which reports
    // the press back through notifyKeyEvent → broadcaster, so this exercises the whole
    // request → driver → websocket loop rather than one endpoint.
    const frame = await page.evaluate(
      () =>
        new Promise<string>((resolve, reject) => {
          const ws = new WebSocket(`ws://${location.host}/api/ws`);
          const timer = setTimeout(() => reject(new Error('no keyEvent within 10s')), 10_000);
          ws.addEventListener('open', () => {
            void fetch('/api/key/3', { method: 'POST' });
          });
          ws.addEventListener('message', (ev) => {
            const msg = JSON.parse(String(ev.data)) as { event: string };
            if (msg.event !== 'keyEvent') return;
            clearTimeout(timer);
            ws.close();
            resolve(String(ev.data));
          });
          ws.addEventListener('error', () => {
            clearTimeout(timer);
            reject(new Error('websocket error'));
          });
        }),
    );

    const parsed = JSON.parse(frame) as {
      event: string;
      data: { mk2Index: number; state: string };
    };
    expect(parsed.event).toBe('keyEvent');
    expect(parsed.data.mk2Index).toBe(3);
  });

  test('renders the mock-mode stage', async ({ page, app }) => {
    await page.goto(`${app.baseURL}/`);
    // driverConnected && !elgatoConnected => StageDeviceNoElgato (ui-helpers.ts deriveState).
    const stage = page.locator('#stage');
    await expect(stage).toContainText('Almost there');
    await expect(stage).toContainText('1 step left');
  });

  test('renders a full key grid for the default model', async ({ page, app }) => {
    await page.goto(`${app.baseURL}/`);
    const grid = page.locator('.key-grid');
    await expect(grid).toHaveCount(1);
    await expect(grid).toHaveAttribute('data-model', /.+/);

    // Default device is the Stream Deck MK.2: 15 keys, 5 columns.
    const cells = page.locator('.key-grid button[data-key]');
    await expect(cells).toHaveCount(15);
    await expect(page.locator('.key-grid button[data-key="14"]')).toHaveCount(1);

    // Without a CORA client no images ever arrive, so the preview must say so rather than
    // claiming to be live.
    await expect(page.locator('.preview .live-dot')).toHaveText('Paused');
  });
});
