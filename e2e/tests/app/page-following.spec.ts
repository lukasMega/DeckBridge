import { click, typeInto } from '../../helpers/click.js';
import { gotoApp } from '../../helpers/goto.js';
import {
  api,
  connectElgato,
  DEFAULT_DEVICE,
  expect,
  getSettings,
  restoreSettings,
  test,
  useDevice,
  waitForState,
  type ElgatoClient,
  type SettingsJson,
} from '../../fixtures/app.js';

/** 15 distinct fake key images for one page; `changed` keys get another body (a live clock). */
function pageFrames(tag: string, changed: number[] = []): Buffer[] {
  return Array.from({ length: 15 }, (_, key) =>
    Buffer.from(`${tag}-key-${key}${changed.includes(key) ? '-live' : ''}`.padEnd(64, '.')),
  );
}

interface PageStateJson {
  activePageId: string | null;
  settling: boolean;
  held: boolean;
}

test.describe('layouts that follow the Elgato page (293S, advertised as MK.2)', () => {
  let elgato: ElgatoClient | undefined;
  let snapshot: SettingsJson;

  test.beforeAll(async ({ app, workerRequest }) => {
    snapshot = await getSettings(workerRequest, app.baseURL);
    await useDevice(workerRequest, app.baseURL, 'mirabox-293s');
    elgato = await connectElgato(workerRequest, app.baseURL, app.childPort);
  });

  test.afterAll(async ({ app, workerRequest }) => {
    await useDevice(workerRequest, app.baseURL, DEFAULT_DEVICE);
    await restoreSettings(workerRequest, app.baseURL, snapshot);
    await elgato?.close();
  });

  test('a saved page brings its own side-key layout, an unknown page the default', async ({
    page,
    request,
    app,
  }) => {
    const base = app.baseURL;
    const send = (frames: Buffer[]): void =>
      frames.forEach((body, key) => elgato!.sendKeyImage(key, body));
    const pageState = async (): Promise<PageStateJson> =>
      (await waitForState(request, base, () => true)).pageState as PageStateJson;
    const waitForPage = (activePageId: string | null) =>
      waitForState(request, base, (s) => {
        const state = s.pageState as PageStateJson;
        return state.activePageId === activePageId && !state.settling && !state.held;
      });

    send(pageFrames('A'));
    await waitForState(request, base, (s) => {
      const state = s.pageState as PageStateJson;
      return !state.settling && !state.held;
    });

    const snap = await api<{ page: { id: string } }>(request, base, '/api/pages/snapshot', {
      name: 'A',
    });
    expect(snap.status).toBe(200);
    const id = snap.json.page.id;
    await waitForPage(id);

    expect((await api(request, base, '/api/pages/layout', { id, mode: 'own' })).status).toBe(200);
    const edit = await api(request, base, '/api/extra-key', {
      wireId: 16,
      widget: 'text',
      param: 'on A',
      pageId: id,
    });
    expect(edit.status).toBe(200);

    // Another page: nothing matches, so the default layout is back. Wait out the animation
    // window first, as a person switching pages would.
    await new Promise((r) => setTimeout(r, 600));
    send(pageFrames('B'));
    await waitForPage(null);

    // A again with one live key (a clock): 14 of 15 keys still match.
    await new Promise((r) => setTimeout(r, 600));
    send(pageFrames('A', [0]));
    await waitForPage(id);
    expect((await pageState()).activePageId).toBe(id);

    await gotoApp(page, `${base}/`);
    await expect(page.locator('#pagesStatus')).toContainText('Showing "A"');
    await expect(page.locator('#savedPagesList')).toHaveAttribute('hidden', '');
    await click(page.locator('#pageManageBtn'));
    await expect(page.locator('.page-row .dock-chip--paired')).toHaveText('Active');
    await expect(page.locator('.page-row .page-options')).toHaveCount(0);
    await click(page.locator('.page-options-toggle'));
    await expect(page.locator('.page-row .page-name')).toHaveValue('A');
    await click(page.locator('#pageManageBtn'));
    await expect(page.locator('#layoutScopeSelect option')).toHaveCount(2);

    // Saving through the UI posts the name and the ignored keys.
    const posted = page.waitForRequest((r) => r.url().endsWith('/api/pages/snapshot'));
    await click(page.locator('#pageSnapshotBtn'));
    await expect(page.locator('.page-form .crop-key')).toHaveCount(0);
    await typeInto(page.locator('#pageNameInput'), 'Copy of A');
    await click(page.locator('#pageSaveBtn'));
    expect((await posted).postDataJSON()).toMatchObject({ name: 'Copy of A' });
    await expect(page.locator('.page-form')).toHaveCount(0);
    await expect(page.locator('.page-row')).toHaveCount(2);
    await expect(page.locator('#pageManageBtn')).toHaveAttribute('aria-expanded', 'true');
  });
});
