import assert from 'tjs:assert';
import { WebUIServer } from '../src/web/server/web-ui-server.js';
import { PersistedSettings } from '../src/infra/settings.js';
import { PushChannels, pushChannels } from '../src/shared/push-channels.js';
import { isAllowedOrigin } from '../src/web/server/web-request-guard.js';
import type { DockStatus } from '../src/shared/types.js';
import { testAsync as test, summaryExit } from './helpers/harness.js';

const ROOT = `${tjs.tmpDir}/push-api-test-${tjs.pid}`;
const PORT = 13041;

const settings = new PersistedSettings(ROOT);
await settings.load();
const ui = new WebUIServer(PORT, [], 'real', settings);
await ui.start();
const base = `http://127.0.0.1:${ui.port}`;

function dock(): DockStatus {
  return {
    index: 0,
    modelId: 'mirabox-293s',
    modelName: '293S',
    keyCount: 15,
    columns: 5,
    rows: 3,
    primaryPort: 5343,
    primaryConnected: true,
    elgatoConnected: true,
    brightness: 100,
    dockFirmwareVersion: '1',
    childFirmwareVersion: '1',
    serialNumber: 'A7FZA5190AAAAA',
    childSerialNumber: 'A7FZA5191AAAAA',
    productId: 0x0080,
    macAddress: '02:00:00:00:00:01',
    mdnsServiceName: 'x',
    deviceKey: 'fake-device-0',
    extraKeys: [16],
  } satisfies DockStatus;
}

const admin = (path: string, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

const created = (await (await admin('/api/push-tokens', { name: 'curl' })).json()) as {
  id: string;
  token: string;
};
const push = (
  channel: string,
  body: unknown,
  headers: Record<string, string> = {},
  token = created.token,
): Promise<Response> =>
  fetch(`${base}/api/push/${channel}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

try {
  console.log('\npush API: auth');

  await test('missing / wrong / non-bearer / correct', async () => {
    const none = await fetch(`${base}/api/push/a`, { method: 'POST', body: '{}' });
    assert.equal(none.status, 401);
    assert.equal(none.headers.get('WWW-Authenticate'), 'Bearer');
    assert.equal((await push('a', { text: 'x' }, {}, 'wrong')).status, 401);
    assert.equal((await push('a', { text: 'x' }, { Authorization: 'Basic x' })).status, 401);
    assert.equal((await push('a', { text: 'x' })).status, 200);
  });

  await test('rotate invalidates the old secret; revoke removes the token', async () => {
    const t2 = (await (await admin('/api/push-tokens', { name: 'two' })).json()) as {
      id: string;
      token: string;
    };
    assert.equal((await push('a', { text: 'x' }, {}, t2.token)).status, 200);
    const rotated = (await (await admin(`/api/push-tokens/${t2.id}/rotate`)).json()) as {
      token: string;
    };
    assert.equal((await push('a', { text: 'x' }, {}, t2.token)).status, 401);
    assert.equal((await push('a', { text: 'x' }, {}, rotated.token)).status, 200);
    assert.equal((await admin(`/api/push-tokens/${t2.id}/revoke`)).status, 200);
    assert.equal((await push('a', { text: 'x' }, {}, rotated.token)).status, 401);
  });

  await test('token list never carries hashes or secrets', async () => {
    const r = await fetch(`${base}/api/push-tokens`);
    const text = await r.text();
    assert.ok(!text.includes('"hash"') && !text.includes(created.token));
    assert.ok(text.includes('"prefix"'));
  });

  await test('Origin: foreign → 403; OPTIONS → 405 without CORS', async () => {
    const evil = await push('a', { text: 'x' }, { Origin: 'http://evil.example' });
    assert.equal(evil.status, 403);
    assert.equal(((await evil.json()) as { code: string }).code, 'forbidden_origin');
    const opt = await fetch(`${base}/api/push/a`, { method: 'OPTIONS' });
    assert.equal(opt.status, 405);
    assert.equal(opt.headers.get('Access-Control-Allow-Origin'), null);
  });

  await test('a token does not authorize admin routes', async () => {
    const r = await fetch(`${base}/api/extra-key`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${created.token}`,
        Origin: 'http://evil.example',
      },
      body: JSON.stringify({ wireId: 16, widget: 'clock' }),
    });
    assert.equal(r.status, 403);
  });

  console.log('\npush API: validation');

  await test('bad bodies and channels', async () => {
    assert.equal((await push('a', 'not json')).status, 400);
    assert.equal(
      ((await (await push('a', 'not json')).json()) as { code: string }).code,
      'invalid_json',
    );
    const ct = await fetch(`${base}/api/push/a`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Authorization: `Bearer ${created.token}` },
      body: '{"text":"x"}',
    });
    assert.equal(ct.status, 415);
    assert.equal((await push('a', { text: 'x'.repeat(5000) })).status, 413);
    const field = await push('a', { text: 'x', ttl: -1 });
    assert.equal(field.status, 400);
    assert.ok(((await field.json()) as { error: string }).error.includes('ttl'));
    assert.equal((await push('Bad%20Name', { text: 'x' })).status, 400);
    assert.equal((await fetch(`${base}/api/push`, { method: 'POST', body: '{}' })).status, 404);
    const get = await fetch(`${base}/api/push/a`);
    assert.equal(get.status, 405);
    assert.ok(get.headers.get('Allow')?.includes('DELETE'));
  });

  await test('upper-case channel is stored lower-case', async () => {
    assert.equal((await push('OBS-REC', { text: 'x' })).status, 200);
    assert.ok(pushChannels.list().some((c) => c.channel === 'obs-rec'));
  });

  console.log('\npush API: semantics');

  await test('expiresAt, bound, replaced/truncated, DELETE idempotent', async () => {
    const before = Date.now();
    const r = (await (await push('sem', { text: 'a\u{1F600}', ttl: 30 })).json()) as {
      expiresAt: number;
      bound: number;
      replaced: number;
      truncated: boolean;
    };
    assert.ok(r.expiresAt >= before + 30_000 && r.expiresAt <= Date.now() + 30_000);
    assert.equal(r.bound, 0);
    assert.equal(r.replaced, 1);
    assert.ok(!r.truncated);

    settings.getOrCreateIdentity('fake-device-0', 'Dock');
    ui.notifyDocks([dock()]);
    assert.equal(ui.extraKeys.trySet(16, { widget: 'external', param: 'sem' }), null);
    const bound = (await (await push('sem', { text: 'x' })).json()) as { bound: number };
    assert.equal(bound.bound, 1);

    for (let i = 0; i < 2; i++) {
      const del = await fetch(`${base}/api/push/sem`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${created.token}` },
      });
      assert.equal(del.status, 204);
    }
    assert.equal(pushChannels.view('sem', Date.now()).state, 'waiting');
  });

  await test('external widget config persists expire and fallbackText via the route', async () => {
    const r = await admin('/api/extra-key', {
      wireId: 16,
      widget: 'external',
      param: 'sem',
      expire: 'text',
      fallbackText: 'off',
    });
    assert.equal(r.status, 200);
    assert.deepEqual(settings.for('fake-device-0').extraKeyConfig(16), {
      widget: 'external',
      param: 'sem',
      expire: 'text',
      fallbackText: 'off',
    });
    assert.equal((await admin('/api/extra-key', { wireId: 16, widget: 'external' })).status, 200);
    assert.equal(
      (await admin('/api/extra-key', { wireId: 16, widget: 'external', param: 'Bad Name' })).status,
      400,
    );
  });

  await test('admin send-test and clear routes', async () => {
    assert.equal((await admin('/api/push-channels/adm', { text: 'hi', ttl: 5 })).status, 200);
    const list = (await (await fetch(`${base}/api/push-channels`)).json()) as {
      channels: Array<{ channel: string }>;
    };
    assert.ok(list.channels.some((c) => c.channel === 'adm'));
    assert.equal((await admin('/api/push-channels/adm/clear')).status, 200);
  });

  await test('pushChanged is emitted once for a burst', async () => {
    let n = 0;
    ui.on('pushChanged', () => n++);
    for (let i = 0; i < 5; i++) await push('burst', { text: String(i) });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(n, 1);
  });

  await test('rate limit: 21 rapid posts → 429 with Retry-After', async () => {
    const t = (await (await admin('/api/push-tokens', { name: 'rl' })).json()) as { token: string };
    const statuses: number[] = [];
    let retry: string | null = null;
    for (let i = 0; i < 25; i++) {
      const r = await push('rl', { text: 'x' }, {}, t.token);
      statuses.push(r.status);
      if (r.status === 429) retry = r.headers.get('Retry-After');
    }
    assert.ok(statuses.includes(429));
    assert.ok(statuses.filter((s) => s === 200).length >= 20);
    assert.ok(retry !== null && Number(retry) >= 1);
  });

  await test('channel limit: 65th live channel → 409', () => {
    const own = new PushChannels();
    for (let i = 0; i < 64; i++) own.set(`c${i}`, { text: 'x', ttlS: 0 }, Date.now());
    assert.equal(own.set('c64', { text: 'x', ttlS: 0 }, Date.now()), 'full');
  });

  console.log('\nisAllowedOrigin');

  await test('loopback origins pass, others fail', () => {
    assert.ok(isAllowedOrigin('http://127.0.0.1:3000', 3000));
    assert.ok(isAllowedOrigin('http://localhost', 3000));
    assert.ok(!isAllowedOrigin('http://evil.example', 3000));
    assert.ok(!isAllowedOrigin('http://127.0.0.1:3001', 3000));
  });
} finally {
  await ui.stop();
}

summaryExit();
