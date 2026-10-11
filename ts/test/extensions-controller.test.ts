import assert from 'tjs:assert';
import { ExtensionsController } from '../src/web/server/extensions-controller.js';
import type { ExtensionHostLike } from '../src/web/server/extensions-controller.js';
import { checkManifest, scanExtensions } from '../src/web/server/extension-manifest.js';
import type { ExtensionHostOptions, ExtensionRunState } from '../src/extension/extension-host.js';
import type { ExtensionEvent, ExtensionRequest } from '../src/extension/api.js';
import { PersistedSettings } from '../src/infra/settings.js';
import { currentLogLevel, setLogLevel, setWebUILog } from '../src/shared/logger.js';
import { sanitizeExtensionGrants } from '../src/infra/settings-sanitize.js';
import { readFolderFiles } from '../src/web/server/extension-digest.js';
import { extensionRoutes } from '../src/web/server/extension-routes.js';
import type { RouteContext, RouteHandler } from '../src/web/server/router.js';
import { test, testAsync as runTest, summaryExit } from './helpers/harness.js';
import { extensionsDisabled } from '../src/shared/cli.js';

const ROOT = `${tjs.tmpDir}/extensions-controller-test-${tjs.pid}`;
const DIR = `${ROOT}/extensions`;
let settingsSeq = 0;

const manifest = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  name: `Ext ${id}`,
  version: '1.0.0',
  apiVersion: 1,
  permissions: { events: ['deckAttached'] },
  ...extra,
});

async function folder(id: string, files: Record<string, string>): Promise<void> {
  await tjs.makeDir(`${DIR}/${id}`, { recursive: true });
  for (const [name, body] of Object.entries(files))
    await tjs.writeFile(`${DIR}/${id}/${name}`, body);
}

/** The digest of a folder as it is on disk right now, as a grant must record it. */
async function digestOf(id: string): Promise<string> {
  const r = await readFolderFiles(`${DIR}/${id}`);
  if (!('digest' in r)) throw new Error(r.problem);
  return r.digest;
}

interface LogLine {
  level: string;
  component: string;
  message: string;
}

/** Captures every line logged while `run` runs; the level and sink are restored after. */
async function captureLogs(run: () => Promise<void>): Promise<LogLine[]> {
  const before = currentLogLevel();
  const lines: LogLine[] = [];
  setLogLevel('debug');
  setWebUILog((level, component, message) => lines.push({ level, component, message }));
  try {
    await run();
  } finally {
    setLogLevel(before);
    setWebUILog(() => undefined);
  }
  return lines;
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
  request(): Promise<{ status: number; json: string }> {
    return Promise.resolve({ status: 200, json: JSON.stringify({ from: this.opts.id }) });
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
  assert.deepEqual(r, {
    manifest: {
      id: 'a',
      name: 'Ext a',
      version: '1.0.0',
      apiVersion: 1,
      permissions: { events: ['deckAttached'] },
    },
  });
});

test('permissions is required', () => {
  const raw: Record<string, unknown> = manifest('a');
  delete raw.permissions;
  assert.ok('problem' in checkManifest(raw, 'a'));
});

test('permissions.events rejects an unknown event type', () => {
  assert.ok(
    'problem' in checkManifest(manifest('a', { permissions: { events: ['input', 'nope'] } }), 'a'),
  );
});

test('permissions.events rejects a duplicate event type', () => {
  assert.ok(
    'problem' in checkManifest(manifest('a', { permissions: { events: ['input', 'input'] } }), 'a'),
  );
});

test('permissions.events accepts an empty list', () => {
  const r = checkManifest(manifest('a', { permissions: { events: [] } }), 'a');
  assert.deepEqual('manifest' in r && r.manifest.permissions, { events: [] });
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

const HEX = 'a'.repeat(64);

test('sanitizeExtensionGrants keeps well-formed grants only', () => {
  const grants = sanitizeExtensionGrants({
    good: { digest: HEX, events: ['input', 'input', 'deckAttached', 'bad name!', 7] },
    'bad id': { digest: HEX, events: [] },
    '../x': { digest: HEX, events: [] },
    badDigest: { digest: 'ABC', events: [] },
    noEvents: { digest: HEX, events: 'input' },
    nul: null,
  });
  assert.deepEqual(grants, { good: { digest: HEX, events: ['input', 'deckAttached'] } });
});

test('sanitizeExtensionGrants gives {} for a non-object or an array', () => {
  assert.deepEqual(sanitizeExtensionGrants(undefined), {});
  assert.deepEqual(sanitizeExtensionGrants(null), {});
  assert.deepEqual(sanitizeExtensionGrants([{ digest: HEX, events: [] }]), {});
  assert.deepEqual(sanitizeExtensionGrants('good'), {});
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
  assert.ok(/^[0-9a-f]{64}$/.test(found.get('good')!.digest ?? ''));
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
  assert.equal(ctl.wants('deckAttached'), false);
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
  assert.equal(await ctl.setEnabled('good', true), null);
  assert.deepEqual(Object.keys(settings.extensionGrants), ['good']);
  assert.equal(hosts.length, 1);
  assert.ok(hosts[0]!.started);
  assert.equal(hosts[0]!.opts.serverPath, `${DIR}/good/server.js`);
  assert.equal(hosts[0]!.opts.appStartedAt, 5);
  assert.deepEqual(hosts[0]!.events, [deck]);
  assert.deepEqual(hosts[0]!.opts.events, ['deckAttached']);
  assert.equal(ctl.wants('deckAttached'), true);
  const info = ctl.view().extensions.find((e) => e.id === 'good')!;
  assert.equal(info.enabled, true);
  assert.equal(info.rev, 1);
  ctl.dispose();
});

await runTest('wants follows the grants of hosts that are not in error', async () => {
  const { ctl, hosts } = await setup();
  await ctl.rescan();
  assert.equal(ctl.wants('deckAttached'), false, 'nothing running');
  await ctl.setEnabled('good', true);
  assert.equal(ctl.wants('deckAttached'), true);
  assert.equal(ctl.wants('input'), false, 'not in the grant');
  assert.equal(ctl.wants('imageProcessed'), false);
  hosts[0]!.state = 'error';
  assert.equal(ctl.wants('deckAttached'), false, 'a failed host takes nothing');
  ctl.dispose();
});

await runTest('events fan out; a failed host takes nothing', async () => {
  const { ctl, hosts } = await setup();
  await ctl.rescan();
  await ctl.setEnabled('good', true);
  const e: ExtensionEvent = { type: 'imageProcessed', at: 2, deviceKey: 'k', cached: true };
  ctl.emit(e);
  assert.deepEqual(hosts[0]!.events, [e]);
  hosts[0]!.state = 'error';
  hosts[0]!.error = 'boom';
  assert.equal(ctl.wants('imageProcessed'), false);
  const info = ctl.view().extensions.find((x) => x.id === 'good')!;
  assert.equal(info.state, 'error');
  assert.equal(info.error, 'boom');
  ctl.dispose();
});

await runTest('enabling again restarts (new rev); disabling stops and persists', async () => {
  const { ctl, hosts, settings } = await setup();
  await ctl.rescan();
  await ctl.setEnabled('good', true);
  await ctl.setEnabled('good', true);
  assert.equal(hosts.length, 2);
  assert.ok(hosts[0]!.stopped);
  assert.equal(ctl.view().extensions.find((e) => e.id === 'good')!.rev, 2);
  assert.equal(await ctl.setEnabled('good', false), null);
  assert.ok(hosts[1]!.stopped);
  assert.deepEqual(settings.extensionGrants, {});
  assert.equal(ctl.view().extensions.find((e) => e.id === 'good')!.state, 'disabled');
});

await runTest('enable rejects bad input, unknown ids and invalid extensions', async () => {
  const { ctl } = await setup();
  await ctl.rescan();
  assert.equal((await ctl.setEnabled(1, true))?.status, 400);
  assert.equal((await ctl.setEnabled('ghost', true))?.status, 404);
  assert.equal((await ctl.setEnabled('noserver', true))?.status, 409);
  assert.equal(await ctl.setEnabled('noserver', false), null, 'turning off is always allowed');
});

await runTest(
  '--no-extensions: rescan starts nothing, enable answers 409, off still works',
  async () => {
    const { ctl, hosts, settings } = await setup();
    settings.grantExtension('good', { digest: await digestOf('good'), events: ['deckAttached'] });
    tjs.env.DECKBRIDGE_NO_EXTENSIONS = '1';
    try {
      assert.equal(extensionsDisabled(), true);
      await ctl.rescan();
      assert.equal(hosts.length, 0, 'a granted extension is not started in safe mode');
      const view = ctl.view();
      assert.equal(view.safeMode, true);
      assert.equal(view.extensions.find((e) => e.id === 'good')!.enabled, true);
      const denied = await ctl.setEnabled('good', true);
      assert.equal(denied?.status, 409);
      assert.equal(denied?.error, 'extensions are off for this session (--no-extensions)');
      assert.equal(hosts.length, 0);
      assert.equal(await ctl.setEnabled('good', false), null, 'switching off still works');
      assert.deepEqual(settings.extensionGrants, {});
    } finally {
      delete tjs.env.DECKBRIDGE_NO_EXTENSIONS;
    }
    assert.equal(ctl.view().safeMode, undefined, 'no safeMode flag without the switch');
    ctl.dispose();
  },
);

await runTest('an id whose folder is gone can still be switched off', async () => {
  const { ctl, settings } = await setup();
  settings.grantExtension('ghost', { digest: HEX, events: [] });
  await ctl.rescan();
  assert.equal(await ctl.setEnabled('ghost', false), null);
  assert.deepEqual(settings.extensionGrants, {});
});

await runTest('a failed folder read keeps running extensions', async () => {
  const { ctl, hosts } = await setup();
  await ctl.rescan();
  await ctl.setEnabled('good', true);
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
  settings.grantExtension('good', { digest: await digestOf('good'), events: ['deckAttached'] });
  await ctl.rescan();
  assert.equal(hosts.length, 1);
  await tjs.rename(`${DIR}/good`, `${ROOT}/good-away`);
  await ctl.rescan();
  assert.ok(hosts[0]!.stopped);
  assert.equal(ctl.view().extensions.length, 2);
  await tjs.rename(`${ROOT}/good-away`, `${DIR}/good`);
  settings.revokeExtension('good');
  ctl.dispose();
});

await runTest('requests and ui.js need a running extension', async () => {
  const { ctl, hosts } = await setup();
  await ctl.rescan();
  const req = { method: 'GET' as const, path: 'x', query: {} };
  assert.equal((await ctl.request('good', req)).status, 404);
  assert.equal(ctl.uiScript('good'), null);
  await ctl.setEnabled('good', true);
  assert.equal(ctl.uiScript('good'), null, 'still loading');
  hosts[0]!.state = 'running';
  assert.deepEqual(await ctl.request('good', req), { status: 200, json: '{"from":"good"}' });
  assert.ok(ctl.uiScript('good')?.includes('mount'));
  await ctl.setEnabled('good', false);
});

await runTest('ui.js is served from memory, not re-read from disk', async () => {
  const { ctl, hosts } = await setup();
  await ctl.rescan();
  await ctl.setEnabled('good', true);
  hosts[0]!.state = 'running';
  const scanned = ctl.uiScript('good');
  await tjs.writeFile(`${DIR}/good/ui.js`, 'export const changed = true;');
  assert.equal(ctl.uiScript('good'), scanned);
  assert.ok(scanned?.includes('mount'));
  await tjs.writeFile(`${DIR}/good/ui.js`, 'export function mount() { return () => {}; }');
  ctl.dispose();
});

await runTest('a folder with a symlink inside is listed as invalid', async () => {
  const linkRoot = `${ROOT}/linked`;
  await tjs.makeDir(`${linkRoot}/linkd`, { recursive: true });
  await tjs.writeFile(`${linkRoot}/linkd/manifest.json`, JSON.stringify(manifest('linkd')));
  await tjs.writeFile(`${linkRoot}/linkd/server.js`, 'export default () => ({});');
  await tjs.symlink(`${linkRoot}/linkd/server.js`, `${linkRoot}/linkd/extra.js`);
  const settings = new PersistedSettings(`${ROOT}/settings-linked`);
  await settings.load();
  const ctl = new ExtensionsController(
    { settings, broadcast: () => undefined },
    { dir: linkRoot, createHost: (o) => new FakeHost(o) },
  );
  await ctl.rescan();
  const info = ctl.view().extensions.find((e) => e.id === 'linkd')!;
  assert.equal(info.state, 'invalid');
  assert.ok(info.error?.startsWith('contains a symlink'));
});

await runTest('dispose stops every host and silences later rescans', async () => {
  const { ctl, hosts, broadcasts } = await setup();
  await ctl.rescan();
  await ctl.setEnabled('good', true);
  const before = broadcasts.length;
  ctl.dispose();
  assert.ok(hosts[0]!.stopped);
  await ctl.rescan();
  assert.equal(broadcasts.length, before);
});

await runTest('enabling stores the folder digest and the manifest events', async () => {
  const { ctl, settings } = await setup();
  await ctl.rescan();
  assert.equal(await ctl.setEnabled('good', true), null);
  assert.deepEqual(settings.extensionGrants.good, {
    digest: await digestOf('good'),
    events: ['deckAttached'],
  });
  ctl.dispose();
});

await runTest('a changed server.js is listed as changed and does not run', async () => {
  const { ctl, hosts } = await setup();
  await ctl.rescan();
  await ctl.setEnabled('good', true);
  hosts[0]!.state = 'running';
  await tjs.writeFile(`${DIR}/good/server.js`, 'export default () => ({ changed: true });');
  await ctl.rescan();
  assert.ok(hosts[0]!.stopped);
  const info = ctl.view().extensions.find((e) => e.id === 'good')!;
  assert.equal(info.state, 'changed');
  assert.equal(info.enabled, true);
  assert.equal(
    info.error,
    'files changed since you switched it on; switch it off and on to run the new files',
  );
  assert.equal(ctl.uiScript('good'), null);
  await tjs.writeFile(`${DIR}/good/server.js`, 'export default () => ({});');
  ctl.dispose();
});

await runTest('switching off and on after a change runs the new files', async () => {
  const { ctl, hosts, settings } = await setup();
  await ctl.rescan();
  await ctl.setEnabled('good', true);
  await tjs.writeFile(`${DIR}/good/server.js`, 'export default () => ({ changed: true });');
  await ctl.rescan();
  assert.equal(ctl.view().extensions.find((e) => e.id === 'good')!.state, 'changed');
  assert.equal(await ctl.setEnabled('good', false), null);
  assert.equal(await ctl.setEnabled('good', true), null);
  assert.equal(settings.extensionGrants.good!.digest, await digestOf('good'));
  assert.equal(hosts.length, 2);
  assert.ok(hosts[1]!.started);
  assert.equal(ctl.view().extensions.find((e) => e.id === 'good')!.state, 'loading');
  await tjs.writeFile(`${DIR}/good/server.js`, 'export default () => ({});');
  ctl.dispose();
});

await runTest('switching on and off writes audit lines in the extensions tag', async () => {
  const { ctl } = await setup();
  await ctl.rescan();
  const digest = await digestOf('good');
  const lines = await captureLogs(async () => {
    await ctl.setEnabled('good', true);
    await ctl.setEnabled('good', false);
  });
  assert.deepEqual(lines, [
    {
      level: 'info',
      component: 'extensions',
      message: `good switched on (digest ${digest.slice(0, 12)})`,
    },
    { level: 'info', component: 'extensions', message: 'good switched off' },
  ]);
  ctl.dispose();
});

await runTest('a changed folder warns once per rescan, never on a plain read', async () => {
  const { ctl } = await setup();
  await ctl.rescan();
  await ctl.setEnabled('good', true);
  await tjs.writeFile(`${DIR}/good/server.js`, 'export default () => ({ changed: true });');
  const warning = 'good: files changed since it was switched on; not started';
  const lines = await captureLogs(async () => {
    await ctl.rescan();
    ctl.view();
    ctl.view();
    await ctl.rescan();
  });
  assert.deepEqual(
    lines,
    [1, 2].map(() => ({ level: 'warn', component: 'extensions', message: warning })),
  );
  await tjs.writeFile(`${DIR}/good/server.js`, 'export default () => ({});');
  ctl.dispose();
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
      return Promise.resolve({ status: 201, json: '{"ok":true}' });
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
  assert.equal(await ok.text(), '{"ok":true}');
  assert.equal(ok.headers.get('Content-Type'), 'application/json');
  assert.deepEqual(seen, [
    { id: 'demo', req: { method: 'POST', path: 'count', query: { x: '1' }, body: { n: 2 } } },
  ]);
  assert.equal((await call('{')).status, 400);
  assert.equal((await call(`"${'x'.repeat(70_000)}"`)).status, 413);
  assert.equal(seen.length, 1, 'rejected bodies never reach the extension');
});

await runTest(
  'cross-site and same-site /api/ext calls get 403; same-origin and no header pass',
  async () => {
    const seen: ExtensionRequest[] = [];
    const extensions = {
      request: (_id: string, req: ExtensionRequest) => {
        seen.push(req);
        return Promise.resolve({ status: 200, json: '{"ok":true}' });
      },
    };
    const call = (site: string | null): Promise<Response> => {
      const url = new URL('http://localhost/api/ext/demo/count');
      const headers = new Headers();
      if (site !== null) headers.set('Sec-Fetch-Site', site);
      const req = new Request(url, { method: 'GET', headers });
      const ctx = { extensions, params: { id: 'demo', path: 'count' }, req, url };
      return Promise.resolve(route('GET', 'api/ext/:id/:path')(ctx as unknown as RouteContext));
    };
    const crossSite = await call('cross-site');
    assert.equal(crossSite.status, 403);
    assert.equal(crossSite.headers.get('Content-Type'), 'application/json');
    assert.equal(await crossSite.text(), '{"error":"cross-site request"}');
    assert.equal((await call('same-site')).status, 403);
    assert.equal(seen.length, 0, 'rejected requests never reach the extension');
    const sameOrigin = await call('same-origin');
    assert.equal(sameOrigin.status, 200);
    assert.equal(await sameOrigin.text(), '{"ok":true}');
    assert.equal((await call('none')).status, 200);
    assert.equal((await call(null)).status, 200);
    assert.equal(seen.length, 3, 'same-origin, none and no-header requests are forwarded');
  },
);

await tjs.remove(ROOT, { recursive: true }).catch(() => undefined);
summaryExit();
