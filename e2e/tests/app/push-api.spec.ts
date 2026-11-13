import { gotoApp } from '../../helpers/goto.js';
import { selectValue } from '../../helpers/click.js';
import {
  api,
  connectElgato,
  DEFAULT_DEVICE,
  deviceEntry,
  expect,
  getSettings,
  restoreSettings,
  test,
  useDevice,
  type ElgatoClient,
  type SettingsJson,
} from '../../fixtures/app.js';

interface Created {
  id: string;
  token: string;
}

interface Channels {
  channels: Array<{ channel: string; text: string; bound: number }>;
}

test.describe('push API (293S side key bound to a channel)', () => {
  let snapshot: SettingsJson;
  let elgato: ElgatoClient | undefined;

  test.beforeAll(async ({ app, workerRequest }) => {
    snapshot = await getSettings(workerRequest, app.baseURL);
    elgato = await connectElgato(workerRequest, app.baseURL, app.childPort);
  });

  test.afterAll(async ({ app, workerRequest }) => {
    await useDevice(workerRequest, app.baseURL, DEFAULT_DEVICE);
    await restoreSettings(workerRequest, app.baseURL, snapshot);
    await elgato?.close();
  });

  test('token push reaches a bound key; browsers and bad tokens are refused', async ({
    page,
    request,
    app,
  }) => {
    const base = app.baseURL;
    await useDevice(request, base, 'mirabox-293s');
    const set = await api(request, base, '/api/extra-key', {
      wireId: 16,
      widget: 'external',
      param: 'obs-rec',
    });
    expect(set.status).toBe(200);
    const created = (
      await api<Created & Record<string, unknown>>(request, base, '/api/push-tokens', {
        name: 'e2e',
      })
    ).json as Created;
    expect(created.token).toMatch(/^dbp_/);
    try {
      const auth = { Authorization: `Bearer ${created.token}` };
      const ok = await request.post(`${base}/api/push/obs-rec`, {
        headers: auth,
        data: { text: 'REC\n00:05', ttl: 30, background: '#b00020' },
      });
      expect(ok.status()).toBe(200);
      expect(await ok.json()).toMatchObject({ ok: true, channel: 'obs-rec', bound: 1 });

      const listed = (
        await api<Channels & Record<string, unknown>>(request, base, '/api/push-channels')
      ).json as Channels;
      expect(listed.channels.find((c) => c.channel === 'obs-rec')).toMatchObject({ bound: 1 });

      const evil = await request.post(`${base}/api/push/obs-rec`, {
        headers: { ...auth, Origin: 'http://evil.example' },
        data: { text: 'x' },
      });
      expect(evil.status()).toBe(403);
      const wrong = await request.post(`${base}/api/push/obs-rec`, {
        headers: { Authorization: 'Bearer dbp_wrong' },
        data: { text: 'x' },
      });
      expect(wrong.status()).toBe(401);

      await gotoApp(page, `${base}/`);
      await expect(page.getByLabel('Top side key widget')).toHaveValue('external');
      const wrapping = page.getByLabel('Top line wrapping');
      await expect(wrapping).toHaveValue('off');
      for (const mode of ['words', 'chars', 'off']) {
        await selectValue(wrapping, mode);
        await expect(wrapping).toHaveValue(mode);
        await expect
          .poll(async () => {
            const cfg = (await deviceEntry(request, base, 'mock:mirabox-293s'))?.extraKeys?.['16'];
            return cfg;
          })
          .toEqual({
            widget: 'external',
            param: 'obs-rec',
            ...(mode === 'off' ? {} : { style: { wrap: mode } }),
          });
      }

      const del = await request.delete(`${base}/api/push/obs-rec`, { headers: auth });
      expect(del.status()).toBe(204);
      const after = (
        await api<Channels & Record<string, unknown>>(request, base, '/api/push-channels')
      ).json as Channels;
      expect(after.channels.find((c) => c.channel === 'obs-rec')).toBeUndefined();
    } finally {
      // restoreSettings does not touch tokens, so revoke explicitly.
      await api(request, base, `/api/push-tokens/${created.id}/revoke`, {});
    }
  });
});
