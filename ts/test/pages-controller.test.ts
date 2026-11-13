import assert from 'tjs:assert';
import { WebUIServer } from '../src/web/server/web-ui-server.js';
import { routes } from '../src/web/server/routes.js';
import { matchRoute } from '../src/web/server/router.js';
import type { Broadcaster } from '../src/web/server/broadcaster.js';
import { PersistedSettings } from '../src/infra/settings.js';
import { MAX_PAGES } from '../src/shared/page-config.js';
import type { PageObservation } from '../src/shared/page-match.js';
import type { DockStatus } from '../src/shared/types.js';
import { test, testAsync, summaryExit } from './helpers/harness.js';
import { makePage, pageHashes } from './helpers/pages.js';

console.log('\npages-controller');

const ROOT = `${tjs.tmpDir}/pages-controller-test-${tjs.pid}`;
const KEY = 'fake-device-0';

const dockStatus = (index: number): DockStatus => ({
  index,
  modelId: 'mk2',
  modelName: 'Stream Deck MK.2',
  keyCount: 15,
  columns: 5,
  rows: 3,
  primaryPort: 5343 + index * 2,
  primaryConnected: true,
  elgatoConnected: true,
  brightness: 100,
  dockFirmwareVersion: '1.01.016',
  childFirmwareVersion: '1.01.000',
  serialNumber: `A7FZA519${index}ILSAA`,
  childSerialNumber: `A7FZA519${index}ILSNQ`,
  productId: 0x0080,
  macAddress: '02:00:00:00:00:01',
  mdnsServiceName: 'Network Stream Deck',
  deviceKey: `fake-device-${index}`,
  extraKeys: [16, 17, 18],
  pressableExtraKeys: [16],
});

function observation(over: Partial<PageObservation> = {}): PageObservation {
  return {
    profile: 'mk2',
    keyCount: 15,
    columns: 5,
    hashes: pageHashes('A'),
    activePageId: null,
    scores: [],
    suggestedIgnore: [],
    settling: false,
    held: false,
    ...over,
  };
}

let setups = 0;

function setup(withDevice = true) {
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(`${ROOT}/${++setups}`));
  if (withDevice) ui.settings.getOrCreateIdentity(KEY, 'Dock');
  ui.notifyDocks([dockStatus(0), dockStatus(1)]);
  const sent: { event: string; data: unknown }[] = [];
  const bus = (ui as unknown as { bus: Broadcaster }).bus;
  const socket = {
    data: undefined,
    sendText: (msg: string) => sent.push(JSON.parse(msg) as { event: string; data: unknown }),
    sendBinary: () => {},
    close: () => {},
  } as unknown as ServerWebSocket;
  bus.websocketHandlers(() => {}).open(socket);
  sent.length = 0;
  const emitted: unknown[][] = [];
  ui.on('pagesChanged', (...args: unknown[]) => emitted.push(args));
  const stored = () => ui.settings.for(KEY).pages();
  const events = (name: string) => sent.filter((m) => m.event === name);
  return { ui, sent, emitted, stored, events };
}

const status = (r: object | null): number | undefined => (r as { status?: number } | null)?.status;
const pageOf = (r: object): { id: string } => (r as { page: { id: string } }).page;

test('notifyObservation: selected dock broadcasts pageState once; duplicates and other docks stay quiet', () => {
  const { ui, events } = setup();
  ui.pages.notifyObservation(0, observation());
  assert.equal(events('pageState').length, 1);
  ui.pages.notifyObservation(0, observation());
  assert.equal(events('pageState').length, 1, 'identical state is not re-sent');
  ui.pages.notifyObservation(0, observation({ settling: true }));
  assert.equal(events('pageState').length, 2);
  ui.pages.notifyObservation(1, observation({ activePageId: 'p1' }));
  assert.equal(events('pageState').length, 2, 'a non-selected dock is silent');
  ui.trySelectDock(1);
  const last = events('pageState').at(-1)!.data as { activePageId: string };
  assert.equal(last.activePageId, 'p1', 'selecting a dock sends its own state');
});

test('snapshot is refused until the page is stable and recognizable', () => {
  const { ui, stored } = setup();
  assert.equal(status(ui.pages.trySnapshot({ name: 'Main' })), 409, 'no observation yet');
  ui.pages.notifyObservation(0, observation({ settling: true }));
  assert.equal(status(ui.pages.trySnapshot({ name: 'Main' })), 409, 'settling');
  ui.pages.notifyObservation(0, observation({ held: true }));
  assert.equal(status(ui.pages.trySnapshot({ name: 'Main' })), 409, 'held');
  ui.pages.notifyObservation(0, observation());
  assert.equal(status(ui.pages.trySnapshot({ name: '' })), 400);
  assert.equal(status(ui.pages.trySnapshot({ name: 'x'.repeat(41) })), 400);
  assert.equal(status(ui.pages.trySnapshot({ name: 'Main', ignore: [15] })), 400);
  assert.equal(stored().length, 0);
});

test('snapshot stores the observed hashes, defaults ignore to the suggestion, and tells the dock', () => {
  const { ui, stored, emitted, events } = setup();
  ui.pages.notifyObservation(0, observation({ suggestedIgnore: [4, 2] }));
  const res = ui.pages.trySnapshot({ name: ' Main ' });
  assert.equal(pageOf(res).id, 'p1');
  const [page] = stored();
  assert.equal(page?.name, 'Main');
  assert.deepEqual(page?.hashes, pageHashes('A'));
  assert.deepEqual(page?.ignore, [2, 4]);
  assert.equal(page?.profile, 'mk2');
  assert.deepEqual(emitted, [[0]]);
  assert.equal((events('pages').at(-1)!.data as { pages: unknown[] }).pages.length, 1);
  assert.ok(!('hashes' in (res as { page: object }).page), 'hashes never reach the browser');
});

test('snapshot limits: MAX_PAGES and nothing left to match', () => {
  const { ui, stored } = setup();
  ui.pages.notifyObservation(0, observation());
  assert.equal(
    status(ui.pages.trySnapshot({ name: 'All', ignore: Array.from({ length: 15 }, (_, i) => i) })),
    422,
  );
  for (let i = 0; i < MAX_PAGES; i++)
    assert.equal(status(ui.pages.trySnapshot({ name: `P${i}` })), undefined);
  assert.equal(stored().length, MAX_PAGES);
  assert.equal(status(ui.pages.trySnapshot({ name: 'one too many' })), 409);
});

test('snapshot without a device entry is a 409', () => {
  const { ui } = setup(false);
  ui.pages.notifyObservation(0, observation());
  assert.equal(status(ui.pages.trySnapshot({ name: 'Main' })), 409);
});

test('update: rename, ignore and minMatch are validated', () => {
  const { ui, stored } = setup();
  ui.pages.notifyObservation(0, observation());
  ui.pages.trySnapshot({ name: 'Main', ignore: [] });
  assert.equal(
    pageOf(ui.pages.tryUpdate({ id: 'p1', name: 'Home', minMatch: 1, ignore: [3, 1] })).id,
    'p1',
  );
  assert.deepEqual(
    [stored()[0]?.name, stored()[0]?.minMatch, stored()[0]?.ignore],
    ['Home', 1, [1, 3]],
  );
  assert.equal(status(ui.pages.tryUpdate({ id: 'p1', ignore: [99] })), 400);
  assert.equal(status(ui.pages.tryUpdate({ id: 'p1', minMatch: 0.4 })), 400);
  assert.equal(status(ui.pages.tryUpdate({ id: 'nope', name: 'x' })), 404);
  assert.equal(
    status(ui.pages.tryUpdate({ id: 'p1', ignore: Array.from({ length: 15 }, (_, i) => i) })),
    422,
  );
});

test('layout: own copies the default map, default drops it, edits go to the page', () => {
  const { ui, stored } = setup();
  ui.settings.for(KEY).setExtraKeyConfigs({ '16': { widget: 'text', param: 'DEF' } });
  ui.pages.notifyObservation(0, observation());
  ui.pages.trySnapshot({ name: 'Main' });
  assert.equal(
    status(ui.extraKeys.trySet(16, { widget: 'clock' }, 'p1')),
    409,
    'no own layout yet',
  );
  assert.deepEqual(pageOf(ui.pages.trySetLayout({ id: 'p1', mode: 'own' })).id, 'p1');
  assert.deepEqual(stored()[0]?.extraKeys, { '16': { widget: 'text', param: 'DEF' } });
  assert.equal(ui.extraKeys.trySet(16, { widget: 'clock' }, 'p1'), null);
  assert.deepEqual(stored()[0]?.extraKeys, { '16': { widget: 'clock' } });
  assert.deepEqual(
    ui.settings.for(KEY).extraKeyConfigs(),
    { '16': { widget: 'text', param: 'DEF' } },
    'the default layout is untouched',
  );
  assert.equal(status(ui.extraKeys.trySet(16, { widget: 'clock' }, 'p9')), 404);
  assert.equal(status(ui.pages.trySetLayout({ id: 'p1', mode: 'bogus' })), 400);
  ui.pages.trySetLayout({ id: 'p1', mode: 'default' });
  assert.equal(stored()[0]?.extraKeys, undefined);
});

test('recapture replaces hashes and profile, keeps name, ignore and layout', () => {
  const { ui, stored } = setup();
  ui.pages.notifyObservation(0, observation());
  ui.pages.trySnapshot({ name: 'Main', ignore: [1] });
  ui.pages.trySetLayout({ id: 'p1', mode: 'own' });
  ui.pages.notifyObservation(0, observation({ hashes: pageHashes('NEW'), profile: 'mk2' }));
  assert.equal(pageOf(ui.pages.tryRecapture({ id: 'p1' })).id, 'p1');
  const [page] = stored();
  assert.deepEqual([page?.name, page?.ignore], ['Main', [1]]);
  assert.deepEqual(page?.hashes, pageHashes('NEW'));
  assert.deepEqual(page?.extraKeys, {});
  assert.equal(status(ui.pages.tryRecapture({ id: 'p9' })), 404);
});

test('delete removes the page and tells the dock', () => {
  const { ui, stored, emitted } = setup();
  ui.pages.notifyObservation(0, observation());
  ui.pages.trySnapshot({ name: 'Main' });
  emitted.length = 0;
  assert.deepEqual(ui.pages.tryDelete({ id: 'p1' }), { ok: true });
  assert.equal(stored().length, 0);
  assert.deepEqual(emitted, [[0]]);
  assert.equal(status(ui.pages.tryDelete({ id: 'p1' })), 404);
});

test('Run now follows the active page layout', () => {
  const { ui } = setup();
  ui.pages.notifyObservation(0, observation());
  ui.pages.trySnapshot({ name: 'Main' });
  ui.pages.trySetLayout({ id: 'p1', mode: 'own' });
  ui.extraKeys.trySet(16, { widget: 'command', param: 'date' }, 'p1');
  assert.equal(status(ui.extraKeys.tryRunNow(16)), 400, 'the default layout has no command');
  ui.pages.notifyObservation(0, observation({ activePageId: 'p1' }));
  assert.equal(ui.extraKeys.tryRunNow(16), null, 'the active page layout does');
});

await testAsync('pluginsInfo includes plugin widgets from saved page layouts', async () => {
  const { ui } = setup();
  ui.settings.for(KEY).setPages([
    makePage('p1', 'A', {
      extraKeys: { '16': { widget: 'plugin', param: 'page-only.js' } },
    }),
  ]);
  const info = await ui.extraKeys.pluginsInfo();
  assert.ok(info.pageStatus?.p1?.['16'], 'page-only plugins need status in the scoped editor');
  assert.equal(info.status['16'], undefined, 'page status must not replace default-layout status');
});

test('fullState carries the selected dock pages and recognition', () => {
  const { ui } = setup();
  ui.pages.notifyObservation(0, observation({ suggestedIgnore: [1] }));
  ui.pages.trySnapshot({ name: 'Main' });
  const state = ui.fullState();
  assert.equal(state.pages.length, 1);
  assert.deepEqual(state.pageState.suggestedIgnore, [1]);
  assert.equal(state.pageState.keyCount, 15);
});

test('notifyDocks prunes observations of vanished docks', () => {
  const { ui } = setup();
  ui.pages.notifyObservation(1, observation({ activePageId: 'p1' }));
  ui.notifyDocks([dockStatus(0)]);
  ui.trySelectDock(1); // refused: no such dock any more
  assert.equal(ui.fullState().pageState.activePageId, null);
  ui.notifyDocks([dockStatus(0), dockStatus(1)]);
  ui.trySelectDock(1);
  assert.equal(ui.fullState().pageState.activePageId, null, 'its observation was pruned');
});

test('a settings import re-matches every dock', () => {
  const { ui, emitted } = setup();
  const page = makePage('p1', 'A');
  const device = {
    deviceKey: KEY,
    mdnsServiceName: 'Dock',
    macAddress: '00:11:22:33:44:55',
    dockSerial: 'A',
    childSerial: 'B',
    pages: [page],
  };
  ui.settingsFile.applyJson(JSON.stringify({ devices: [device] }));
  assert.ok(
    emitted.some((args) => args.length === 0),
    'pagesChanged without an index = all docks',
  );
  assert.equal(ui.settings.for(KEY).pages().length, 1);
});

/** Run a POST through the real route table. */
async function post(ui: WebUIServer, path: string, body: unknown): Promise<Response> {
  const url = new URL(`http://localhost${path}`);
  const matched = matchRoute(routes, 'POST', url.pathname)!;
  const req = new Request(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
  return matched.handler(Object.assign({}, ui, { req, url, params: matched.params, ui }));
}

{
  const { ui, stored } = setup();
  ui.pages.notifyObservation(0, observation());
  await testAsync('routes: snapshot, extra-key with pageId, and bad bodies', async () => {
    assert.equal((await post(ui, '/api/pages/snapshot', { name: 'Main' })).status, 200);
    assert.equal((await post(ui, '/api/pages/snapshot', [])).status, 400);
    assert.equal((await post(ui, '/api/pages/layout', { id: 'p1', mode: 'own' })).status, 200);
    const widget = { wireId: 16, widget: 'text', param: 'on A' };
    assert.equal((await post(ui, '/api/extra-key', { ...widget, pageId: 'p1' })).status, 200);
    assert.equal(stored()[0]?.extraKeys?.['16']?.param, 'on A');
    assert.equal(ui.settings.for(KEY).extraKeyConfig(16), undefined, 'default map untouched');
    assert.equal((await post(ui, '/api/extra-key', { ...widget, pageId: 3 })).status, 400);
    assert.equal((await post(ui, '/api/extra-key', { ...widget, pageId: 'p9' })).status, 404);
    assert.equal(
      (await post(ui, '/api/extra-key/press', { wireId: 16, command: 'ls', pageId: 'p1' })).status,
      200,
    );
    assert.equal(stored()[0]?.extraKeys?.['16']?.pressCommand, 'ls');
    assert.equal(
      (await post(ui, '/api/extra-key/press', { wireId: 16, command: 'ls', pageId: 7 })).status,
      400,
    );
  });
}

summaryExit();
