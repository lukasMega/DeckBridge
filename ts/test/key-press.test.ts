import assert from 'tjs:assert';
import { KEY_PRESS_DISABLED, checkKeyPress } from '../src/web/server/key-press.js';
import { WebUIServer } from '../src/web/server/web-ui-server.js';
import { PersistedSettings } from '../src/infra/settings.js';
import { loadSettings } from '../src/infra/settings-store.js';
import type { DockStatus } from '../src/shared/types.js';
import { testAsync as test, summaryExit } from './helpers/harness.js';

const ROOT = `${tjs.tmpDir}/key-press-test-${tjs.pid}`;
const PORT = 13091;
const dock = { index: 2, keyCount: 15 } as DockStatus;

console.log('\nclick-to-press guard');

await test('disabled by default: 403 before anything else', () => {
  assert.deepEqual(checkKeyPress(false, dock, 1), { status: 403, error: KEY_PRESS_DISABLED });
  assert.equal((checkKeyPress(false, undefined, 1) as { status: number }).status, 403);
});

await test('enabled: dock and index validated', () => {
  assert.deepEqual(checkKeyPress(true, dock, 14), { dock: 2, index: 14 });
  assert.equal((checkKeyPress(true, dock, 15) as { status: number }).status, 400);
  assert.equal((checkKeyPress(true, dock, -1) as { status: number }).status, 400);
  assert.equal((checkKeyPress(true, dock, 1.5) as { status: number }).status, 400);
  assert.equal((checkKeyPress(true, dock, Number.NaN) as { status: number }).status, 400);
  assert.equal((checkKeyPress(true, undefined, 1) as { status: number }).status, 409);
});

const settings = new PersistedSettings(ROOT);
await settings.load();
const ui = new WebUIServer(PORT, [], 'real', settings);
await ui.start();
const base = `http://127.0.0.1:${PORT}`;
const post = (path: string, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
const presses: unknown[] = [];
ui.on('keyPress', (p: unknown) => presses.push(p));
ui.notifyDocks([
  {
    ...dock,
    index: 0,
    modelId: 'x',
    modelName: 'x',
    columns: 5,
    rows: 3,
    deviceKey: 'k',
  },
]);

try {
  console.log('\nclick-to-press route');

  await test('off by default: POST /api/key/:n is 403 and emits nothing; state says so', async () => {
    const r = await post('/api/key/3');
    assert.equal(r.status, 403);
    assert.equal(((await r.json()) as { error: string }).error, KEY_PRESS_DISABLED);
    assert.deepEqual(presses, []);
    const state = (await (await fetch(`${base}/api/state`)).json()) as { keyPressEnabled: boolean };
    assert.equal(state.keyPressEnabled, false);
  });

  await test('toggle on: validates the body, persists, state follows, the press reaches main', async () => {
    assert.equal((await post('/api/webui-key-press', { enabled: 'yes' })).status, 400);
    assert.equal((await post('/api/webui-key-press', { enabled: true })).status, 200);
    await settings.flush();
    assert.equal((await loadSettings(ROOT)).webuiKeyPress, true);
    const state = (await (await fetch(`${base}/api/state`)).json()) as { keyPressEnabled: boolean };
    assert.equal(state.keyPressEnabled, true);
    assert.equal((await post('/api/key/3')).status, 204);
    assert.deepEqual(presses, [{ dock: 0, index: 3 }]);
    assert.equal((await post('/api/key/15')).status, 400);
    assert.equal(presses.length, 1);
  });

  await test('toggle off again; a settings import never switches it on', async () => {
    assert.equal((await post('/api/webui-key-press', { enabled: false })).status, 200);
    assert.equal((await post('/api/key/3')).status, 403);
    ui.settingsFile.applyJson(
      JSON.stringify({ webuiKeyPress: true, virtualDeck: { enabled: true, profile: 'mk2' } }),
    );
    assert.equal(settings.webuiKeyPress, false);
    assert.equal(settings.virtualDeck.enabled, false);
  });
} finally {
  await ui.stop();
  await settings.close();
}

summaryExit();
