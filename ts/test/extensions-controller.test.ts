import assert from 'tjs:assert';
import { ExtensionsController } from '../src/web/server/extensions-controller.js';
import type { ExtensionHostLike } from '../src/web/server/extensions-controller.js';
import { checkManifest, scanExtensions } from '../src/web/server/extension-manifest.js';
import type { ExtensionHostOptions, ExtensionRunState } from '../src/extension/extension-host.js';
import type { ExtensionEvent, ExtensionRequest } from '../src/extension/api.js';
import { PersistedSettings } from '../src/infra/settings.js';
import { sanitizeExtensionIds } from '../src/infra/settings-sanitize.js';
import { extensionRoutes } from '../src/web/server/extension-routes.js';
import type { RouteContext, RouteHandler } from '../src/web/server/router.js';
import { test, testAsync as runTest, summaryExit } from './helpers/harness.js';

const ROOT = `${tjs.tmpDir}/extensions-controller-test-${tjs.pid}`;
const DIR = `${ROOT}/extensions`;
let settingsSeq = 0;

const manifest = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  name: `Ext ${id}`,
  version: '1.0.0',
  apiVersion: 1,
  ...extra,
});

async function folder(id: string, files: Record<string, string>): Promise<void> {
  await tjs.makeDir(`${DIR}/${id}`, { recursive: true });
  for (const [name, body] of Object.entries(files))
    await tjs.writeFile(`${DIR}/${id}/${name}`, body);
}

class FakeHost implements ExtensionHostLike {
  state: ExtensionRunState = 'loading';
  error: string | undefined;
  started = false;
  stopped = false;
  events: ExtensionEvent[] = [];
  constructor(readonly opts: ExtensionHostOptions) {}
  start(): void {
    this.started = true;
    this.events.push(...(this.opts.initialEvents?.() ?? []));
  }
  stop(): void {
    this.stopped = true;
  }
  emit(event: ExtensionEvent): void {
    this.events.push(event);
  }
  request(): Promise<{ status: number; body: unknown }> {
    return Promise.resolve({ status: 200, body: { from: this.opts.id } });
  }
}

async function setup(): Promise<{
  ctl: ExtensionsController;
  hosts: FakeHost[];
  settings: PersistedSettings;
  broadcasts: unknown[];
}> {
  // A settings root per case: an enable must not leak into the next one.
  const settings = new PersistedSettings(`${ROOT}/settings-${++settingsSeq}`);
  await settings.load();
  const hosts: FakeHost[] = [];
  const broadcasts: unknown[] = [];
  const ctl = new ExtensionsController(
    { settings, broadcast: (_event, payload) => broadcasts.push(payload) },
    {
      dir: DIR,
      appStartedAt: 5,
      createHost: (o) => {
        const h = new FakeHost(o);
        hosts.push(h);
        return h;
      },
    },
  );
  return { ctl, hosts, settings, broadcasts };
}

console.log('\ncheckManifest');

test('accepts a minimal manifest and keeps only known fields', () => {
  const r = checkManifest({ ...manifest('a'), extra: 1 }, 'a');
  assert.deepEqual(r, { manifest: { id: 'a', name: 'Ext a', version: '1.0.0', apiVersion: 1 } });
});

test('rejects an id that differs from the folder', () => {
  assert.ok('problem' in checkManifest(manifest('a'), 'b'));
});

test('rejects another apiVersion, naming both versions', () => {
  const r = checkManifest(manifest('a', { apiVersion: 2 }), 'a');
  assert.ok('problem' in r && r.problem.includes('2') && r.problem.includes('1'));
});

test('a page needs a title; its icon must be inline svg', () => {
  assert.ok('problem' in checkManifest(manifest('a', { page: {} }), 'a'));
  assert.ok('problem' in checkManifest(manifest('a', { page: { title: 'T', icon: 'x' } }), 'a'));
  const ok = checkManifest(manifest('a', { page: { title: 'T', icon: '<svg/>' } }), 'a');
  assert.deepEqual('manifest' in ok && ok.manifest.page, { title: 'T', icon: '<svg/>' });
});

test('sanitizeExtensionIds keeps well-formed unique ids', () => {
  assert.deepEqual(sanitizeExtensionIds(['a', 'a', 'B', '../x', 3, 'ok-1']), ['a', 'ok-1']);
  assert.deepEqual(sanitizeExtensionIds('a'), []);
});

console.log('\nscanExtensions');

await tjs.remove(ROOT, { recursive: true }).catch(() => undefined);
await folder('good', {
  'manifest.json': JSON.stringify(manifest('good', { page: { title: 'Good' } })),
  'server.js': 'export default () => ({});',
  'ui.js': 'export function mount() { return () => {}; }',
});
await folder('noserver', { 'manifest.json': JSON.stringify(manifest('noserver')) });
await folder('badjson', { 'manifest.json': '{', 'server.js': '' });
await folder('Bad_Name', { 'manifest.json': JSON.stringify(manifest('Bad_Name')) });
await tjs.writeFile(`${DIR}/loose.js`, '');

await runTest('finds folders with an addressable id, sorted, with their problems', async () => {
  const found = await scanExtensions(DIR);
  assert.deepEqual([...found.keys()], ['badjson', 'good', 'noserver']);
  assert.equal(found.get('good')!.problem, undefined);
  assert.equal(found.get('noserver')!.problem, 'server.js is missing');
  assert.ok(found.get('badjson')!.problem?.startsWith('manifest.json unreadable'));
});

await runTest('a missing directory is simply empty', async () => {
  assert.equal((await scanExtensions(`${ROOT}/nope`)).size, 0);
});

console.log('\nExtensionsController');

await runTest('rescan lists everything, starts nothing until enabled', async () => {
  const { ctl, hosts, broadcasts } = await setup();
  await ctl.rescan();
  const view = ctl.view();
  assert.equal(view.dir, DIR);
  assert.deepEqual(
    view.extensions.map((e) => [e.id, e.state]),
    [
      ['badjson', 'invalid'],
      ['good', 'disabled'],
      ['noserver', 'invalid'],
    ],
  );
  assert.equal(hosts.length, 0);
  assert.equal(ctl.active, false);
  assert.equal(broadcasts.length, 1);
});

await runTest('enable persists, starts a host and replays the attached decks', async () => {
  const { ctl, hosts, settings } = await setup();
  const deck: ExtensionEvent = {
    type: 'deckAttached',
    at: 1,
    deviceKey: 'k',
    modelName: 'M',
    source: 'usb',
    hasEncoders: false,
    columns: 5,
    extraKeys: [],
  };
  ctl.setDeckSource(() => [deck]);
  await ctl.rescan();
  assert.equal(ctl.setEnabled('good', true), null);
  assert.deepEqual(settings.enabledExtensions, ['good']);
  assert.equal(hosts.length, 1);
  assert.ok(hosts[0]!.started);
  assert.equal(hosts[0]!.opts.serverPath, `${DIR}/good/server.js`);
  assert.equal(hosts[0]!.opts.appStartedAt, 5);
  assert.deepEqual(hosts[0]!.events, [deck]);
  assert.equal(ctl.active, true);
  const info = ctl.view().extensions.find((e) => e.id === 'good')!;
  assert.equal(info.enabled, true);
  assert.equal(info.rev, 1);
  ctl.dispose();
});

await runTest('events fan out; a failed host no longer counts as active', async () => {
  const { ctl, hosts } = await setup();
  await ctl.rescan();
  ctl.setEnabled('good', true);
  const e: ExtensionEvent = { type: 'imageProcessed', at: 2, deviceKey: 'k', cached: true };
  ctl.emit(e);
  assert.deepEqual(hosts[0]!.events, [e]);
  hosts[0]!.state = 'error';
  hosts[0]!.error = 'boom';
  assert.equal(ctl.active, false);
  const info = ctl.view().extensions.find((x) => x.id === 'good')!;
  assert.equal(info.state, 'error');
  assert.equal(info.error, 'boom');
  ctl.dispose();
});

await runTest('enabling again restarts (new rev); disabling stops and persists', async () => {
  const { ctl, hosts, settings } = await setup();
  await ctl.rescan();
  ctl.setEnabled('good', true);
  ctl.setEnabled('good', true);
  assert.equal(hosts.length, 2);
  assert.ok(hosts[0]!.stopped);
  assert.equal(ctl.view().extensions.find((e) => e.id === 'good')!.rev, 2);
  assert.equal(ctl.setEnabled('good', false), null);
  assert.ok(hosts[1]!.stopped);
  assert.deepEqual(settings.enabledExtensions, []);
  assert.equal(ctl.view().extensions.find((e) => e.id === 'good')!.state, 'disabled');
});

await runTest('enable rejects bad input, unknown ids and invalid extensions', async () => {
  const { ctl } = await setup();
  await ctl.rescan();
  assert.equal(ctl.setEnabled(1, true)?.status, 400);
  assert.equal(ctl.setEnabled('ghost', true)?.status, 404);
  assert.equal(ctl.setEnabled('noserver', true)?.status, 409);
  assert.equal(ctl.setEnabled('noserver', false), null, 'turning off is always allowed');
});

await runTest('an id whose folder is gone can still be switched off', async () => {
  const { ctl, settings } = await setup();
  settings.setExtensionEnabled('ghost', true);
  await ctl.rescan();
  assert.equal(ctl.setEnabled('ghost', false), null);
  assert.deepEqual(settings.enabledExtensions, []);
});

await runTest('a failed folder read keeps running extensions', async () => {
  const { ctl, hosts } = await setup();
  await ctl.rescan();
  ctl.setEnabled('good', true);
  await tjs.rename(DIR, `${ROOT}/extensions-away`);
  await tjs.writeFile(DIR, 'not a folder');
  await ctl.rescan();
  assert.ok(!hosts[0]!.stopped);
  assert.equal(ctl.view().extensions.length, 3);
  await tjs.remove(DIR);
  await tjs.rename(`${ROOT}/extensions-away`, DIR);
  ctl.dispose();
});

await runTest('only the newest of overlapping rescans applies', async () => {
  const { ctl, broadcasts } = await setup();
  const first = ctl.rescan();
  const second = ctl.rescan();
  await Promise.all([first, second]);
  assert.equal(broadcasts.length, 1);
  assert.equal(ctl.view().extensions.length, 3);
});

await runTest('a persisted enable starts on rescan; a vanished folder stops', async () => {
  const { ctl, hosts, settings } = await setup();
  settings.setExtensionEnabled('good', true);
  await ctl.rescan();
  assert.equal(hosts.length, 1);
  await tjs.rename(`${DIR}/good`, `${ROOT}/good-away`);
  await ctl.rescan();
  assert.ok(hosts[0]!.stopped);
  assert.equal(ctl.view().extensions.length, 2);
  await tjs.rename(`${ROOT}/good-away`, `${DIR}/good`);
  settings.setExtensionEnabled('good', false);
  ctl.dispose();
});

await runTest('requests and ui.js need a running extension', async () => {
  const { ctl, hosts } = await setup();
  await ctl.rescan();
  const req = { method: 'GET' as const, path: 'x', query: {} };
  assert.equal((await ctl.request('good', req)).status, 404);
  assert.equal(await ctl.uiScript('good'), null);
  ctl.setEnabled('good', true);
  assert.equal(await ctl.uiScript('good'), null, 'still loading');
  hosts[0]!.state = 'running';
  assert.deepEqual(await ctl.request('good', req), { status: 200, body: { from: 'good' } });
  assert.ok((await ctl.uiScript('good'))?.includes('mount'));
  ctl.setEnabled('good', false);
});

await runTest('dispose stops every host and silences later rescans', async () => {
  const { ctl, hosts, broadcasts } = await setup();
  await ctl.rescan();
  ctl.setEnabled('good', true);
  const before = broadcasts.length;
  ctl.dispose();
  assert.ok(hosts[0]!.stopped);
  await ctl.rescan();
  assert.equal(broadcasts.length, before);
});

console.log('\nextension routes');

function route(method: string, path: string): RouteHandler {
  const r = extensionRoutes.find((x) => x.method === method && x.segments.join('/') === path);
  if (!r) throw new Error(`no route ${method} ${path}`);
  return r.handler;
}

await runTest('the proxy forwards path, query and JSON body; big bodies get 413', async () => {
  const seen: { id: string; req: ExtensionRequest }[] = [];
  const extensions = {
    request: (id: string, req: ExtensionRequest) => {
      seen.push({ id, req });
      return Promise.resolve({ status: 201, body: { ok: true } });
    },
  };
  const call = (body: string): Promise<Response> => {
    const url = new URL('http://localhost/api/ext/demo/count?x=1');
    const req = new Request(url, { method: 'POST', body });
    const ctx = { extensions, params: { id: 'demo', path: 'count' }, req, url };
    return Promise.resolve(route('POST', 'api/ext/:id/:path')(ctx as unknown as RouteContext));
  };
  const ok = await call('{"n":2}');
  assert.equal(ok.status, 201);
  assert.deepEqual(seen, [
    { id: 'demo', req: { method: 'POST', path: 'count', query: { x: '1' }, body: { n: 2 } } },
  ]);
  assert.equal((await call('{')).status, 400);
  assert.equal((await call(`"${'x'.repeat(70_000)}"`)).status, 413);
  assert.equal(seen.length, 1, 'rejected bodies never reach the extension');
});

await tjs.remove(ROOT, { recursive: true }).catch(() => undefined);
summaryExit();
