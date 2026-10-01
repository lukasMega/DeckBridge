import { connect, type Socket } from 'node:net';
import type { APIRequestContext } from '@playwright/test';
import { api, expect, test, waitForState } from '../../fixtures/app.js';
import { gotoApp } from '../../helpers/goto.js';

// REPORT_BUTTON_STATE_INPUT, INPUT_SUBTYPE_BUTTONS, then the key count (MK.2 = 15); the
// per-key states follow after a 4-byte header (cora/protocol.ts KEY_EVENT_STATE_OFFSET).
const BUTTONS_HEADER = Buffer.from([0x01, 0x00, 0x0f]);
const STATE_OFFSET = 4;

interface DeckState {
  enabled: boolean;
  listening: boolean;
  devices: Array<{ id: string; connected: boolean }>;
  pending?: { expiresAt: number };
  coraPorts: { primary: number; child: number };
}
interface Offer {
  shortCode: string;
  qrUrl: string;
}

const deckState = async (request: APIRequestContext, base: string): Promise<DeckState> =>
  (await api<DeckState & Record<string, unknown>>(request, base, '/api/virtual-deck')).json;

/** Last key state for `key` in the button-state reports the fake Elgato app received. */
function lastKeyState(received: Buffer, key: number): number | undefined {
  let last: number | undefined;
  for (
    let i = received.indexOf(BUTTONS_HEADER);
    i >= 0;
    i = received.indexOf(BUTTONS_HEADER, i + 1)
  ) {
    const v = received[i + STATE_OFFSET + key];
    if (v !== undefined) last = v;
  }
  return last;
}

test.describe('browser deck (dock 3 + deck listener)', () => {
  test.afterAll(async ({ app, workerRequest }) => {
    await api(workerRequest, app.baseURL, '/api/virtual-deck/revoke-all', {});
    await api(workerRequest, app.baseURL, '/api/virtual-deck', { enabled: false });
  });

  test('off by default; enabling adds dock 3 and a deck-only listener', async ({
    request,
    app,
  }) => {
    const before = await deckState(request, app.baseURL);
    expect(before.enabled).toBe(false);
    expect(before.listening).toBe(false);

    const res = await api(request, app.baseURL, '/api/virtual-deck', { enabled: true });
    expect(res.status).toBe(200);
    await expect.poll(async () => (await deckState(request, app.baseURL)).listening).toBe(true);

    const state = await waitForState(
      request,
      app.baseURL,
      (s) => (s.docks as Array<{ index: number }> | undefined)?.some((d) => d.index === 3) === true,
    );
    const dock3 = (
      state.docks as Array<{ index: number; virtualClients?: number; keyCount: number }>
    ).find((d) => d.index === 3)!;
    expect(dock3.virtualClients).toBe(0);
    expect(dock3.keyCount).toBe(15);

    // The deck listener serves the page and nothing of the admin surface.
    expect((await request.get(`${app.deckURL}/deck/`)).status()).toBe(200);
    expect((await request.get(`${app.deckURL}/api/state`)).status()).toBe(404);
    expect((await request.get(`${app.deckURL}/api/virtual-deck`)).status()).toBe(404);
  });

  test('pair a page, press a key (Elgato app sees it), revoke (page returns to pairing)', async ({
    page,
    request,
    app,
  }) => {
    const base = app.baseURL;
    const offer = (
      await api<Offer & Record<string, unknown>>(request, base, '/api/virtual-deck/pairing', {})
    ).json as Offer;
    expect(offer.qrUrl).toContain('/deck/#pair=');
    const pairUrl = offer.qrUrl.replace(/^http:\/\/[^/]+/, app.deckURL);

    await gotoApp(page, pairUrl);
    await expect(page.locator('.deck-key')).toHaveCount(15);
    await expect
      .poll(async () => (await deckState(request, base)).devices.some((d) => d.connected))
      .toBe(true);

    // Stand in for the Elgato app on dock 3's child port.
    const sock: Socket = connect({ port: app.virtualChildPort, host: '127.0.0.1' });
    const chunks: Buffer[] = [];
    sock.on('data', (c: Buffer) => chunks.push(c));
    sock.on('error', () => {});
    await new Promise<void>((resolve, reject) => {
      sock.once('connect', resolve);
      sock.once('error', reject);
    });
    try {
      await expect.poll(async () => (await deckState(request, base)).pending).toBeUndefined();
      // Lightpanda cannot always synthesize pointer input (see e2e/README.md); the real-Chrome
      // test-client run covers the press path in depth, so skip rather than fail here.
      const dispatched = await page.evaluate(() => {
        const key = document.querySelectorAll('.deck-key')[3];
        if (!key || typeof PointerEvent === 'undefined') return false;
        const init = {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: 'touch',
          isPrimary: true,
        };
        key.dispatchEvent(new PointerEvent('pointerdown', init));
        key.dispatchEvent(new PointerEvent('pointerup', init));
        return true;
      });
      test.skip(!dispatched, 'this browser cannot dispatch PointerEvent');
      await expect.poll(() => lastKeyState(Buffer.concat(chunks), 3)).toBe(0);
      const all = Buffer.concat(chunks);
      let sawDown = false;
      for (let i = all.indexOf(BUTTONS_HEADER); i >= 0; i = all.indexOf(BUTTONS_HEADER, i + 1)) {
        if (all[i + STATE_OFFSET + 3] === 1) sawDown = true;
      }
      expect(sawDown, 'a button-state report with key 3 down').toBe(true);

      // Revoking the device drops its page straight back to the pair screen.
      const devices = (await deckState(request, base)).devices;
      expect(devices.length).toBeGreaterThan(0);
      for (const d of devices) {
        expect((await api(request, base, '/api/virtual-deck/revoke', { id: d.id })).status).toBe(
          204,
        );
      }
      await expect(page.locator('#pair-screen')).toBeVisible();
      await expect.poll(async () => (await deckState(request, base)).devices.length).toBe(0);
    } finally {
      sock.destroy();
    }
  });

  test('disabling removes dock 3 and closes the listener', async ({ request, app }) => {
    const base = app.baseURL;
    expect((await api(request, base, '/api/virtual-deck', { enabled: false })).status).toBe(200);
    await waitForState(
      request,
      base,
      (s) =>
        (s.docks as Array<{ index: number }> | undefined)?.every((d) => d.index !== 3) !== false,
    );
    await expect.poll(async () => (await deckState(request, base)).listening).toBe(false);
    let refused = false;
    try {
      await request.get(`${app.deckURL}/deck/`);
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });
});
