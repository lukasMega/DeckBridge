import assert from 'tjs:assert';
import { WebUIServer } from '../src/web/server/web-ui-server.js';
import { PersistedSettings } from '../src/infra/settings.js';
import { DeckHub, type DeckSource } from '../src/web/server/virtual-deck/deck-hub.js';
import { DeckServer } from '../src/web/server/virtual-deck/deck-server.js';
import { DECK_PROTOCOL_VERSION } from '../src/web/server/virtual-deck/deck-constants.js';
import { testAsync as test, summaryExit } from './helpers/harness.js';

const ROOT = `${tjs.tmpDir}/deck-server-test-${tjs.pid}`;
const WEBUI_PORT = 13061;
const DECK_PORT = 13062;

const settings = new PersistedSettings(ROOT);
await settings.load();
const ui = new WebUIServer(WEBUI_PORT, [], 'real', settings);
await ui.start();
const admin = ui.virtualDeck;

const inputs: string[] = [];
const source: DeckSource = {
  layout: () => ({ profile: 'mk2', columns: 5, rows: 3, keyCount: 15, rotate: 180 }),
  snapshot: () => [],
  brightness: () => 100,
  elgatoPaired: () => false,
  input: (k, s) => inputs.push(`${k}:${s}`),
};
const hub = new DeckHub({
  source,
  auth: admin.auth,
  limits: admin.limits,
  now: () => Date.now(),
});
const mkServer = (): DeckServer =>
  new DeckServer({ port: DECK_PORT, listenIp: '127.0.0.1', hub, auth: admin.auth });
let deck = mkServer();
await deck.start();
admin.runtime = { server: deck, hub };
const base = `http://127.0.0.1:${DECK_PORT}`;

const pairWith = (body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${base}/deck/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

interface Socket {
  ws: WebSocket;
  texts: Record<string, unknown>[];
  binaries: Uint8Array[];
  waitFor(pred: () => boolean): Promise<void>;
}

async function openSocket(): Promise<Socket> {
  const ws = new WebSocket(`ws://127.0.0.1:${DECK_PORT}/deck/ws`);
  ws.binaryType = 'arraybuffer';
  const s: Socket = {
    ws,
    texts: [],
    binaries: [],
    async waitFor(pred) {
      for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 20));
      assert.ok(pred(), 'timed out waiting for socket state');
    },
  };
  ws.addEventListener('message', (e) => {
    if (typeof e.data === 'string') s.texts.push(JSON.parse(e.data) as Record<string, unknown>);
    else s.binaries.push(new Uint8Array(e.data as ArrayBuffer));
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('ws error')));
  });
  return s;
}

const hello = (s: Socket, token: string): void =>
  s.ws.send(
    JSON.stringify({ t: 'hello', v: DECK_PROTOCOL_VERSION, token, clientId: 'c1', now: 1 }),
  );

async function pairedToken(name = 'iPad'): Promise<{ token: string; deviceId: string }> {
  const offer = admin.createPairing();
  assert.ok(!('error' in offer), 'pairing offer');
  const res = await pairWith({ shortCode: (offer as { shortCode: string }).shortCode, name });
  assert.equal(res.status, 200);
  return (await res.json()) as { token: string; deviceId: string };
}

try {
  console.log('\ndeck server: HTTP surface');

  await test('GET /deck/ is 200 with the security headers; / redirects; nothing else exists', async () => {
    const page = await fetch(`${base}/deck/`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('X-Frame-Options'), 'DENY');
    assert.equal(page.headers.get('Referrer-Policy'), 'no-referrer');
    assert.equal(page.headers.get('Cache-Control'), 'no-store');
    await page.text();
    const root = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('Location'), '/deck/');
    for (const path of [
      '/api/state',
      '/api/settings',
      '/api/virtual-deck',
      '/ui.js',
      '/deck/api/pair',
    ]) {
      const r = await fetch(`${base}${path}`);
      assert.equal(r.status, 404, path);
      await r.text();
    }
  });

  await test('foreign Origin and foreign Host are refused', async () => {
    const origin = await pairWith({ code: 'x' }, { Origin: 'https://evil.example' });
    assert.equal(origin.status, 403, `origin ${origin.status}`);
    const host = await fetch(`${base}/deck/`, { headers: { Host: 'evil.example' } });
    assert.ok(host.status === 403 || host.status === 400, `host ${host.status}`);
  });

  console.log('\ndeck server: pairing and the WebSocket');

  await test('pair over HTTP, hello over WS → welcome; frames arrive as binary', async () => {
    const { token } = await pairedToken();
    const s = await openSocket();
    hello(s, token);
    await s.waitFor(() => s.texts.some((m) => m.t === 'welcome'));
    hub.frame(3, new Uint8Array([0xff, 0xd8]), 'jpeg');
    await s.waitFor(() => s.binaries.length === 1);
    assert.deepEqual([...s.binaries[0]!], [1, 3, 0, 0, 0xff, 0xd8]);
    s.ws.send(JSON.stringify({ t: 'key', k: 2, s: 'down', now: 5 }));
    s.ws.send(JSON.stringify({ t: 'key', k: 2, s: 'up', now: 6 }));
    await s.waitFor(() => inputs.length >= 2);
    assert.deepEqual(inputs.slice(-2), ['2:down', '2:up']);
    s.ws.close();
  });

  await test('a wrong code is 403, a used code is 410', async () => {
    const offer = admin.createPairing() as { shortCode: string };
    const wrong = offer.shortCode === '000000' ? '000001' : '000000';
    assert.equal((await pairWith({ shortCode: wrong })).status, 403);
    assert.equal((await pairWith({ shortCode: offer.shortCode })).status, 200);
    assert.equal((await pairWith({ shortCode: offer.shortCode })).status, 410);
  });

  await test('scope separation: a push token cannot open the deck; a deck token cannot push', async () => {
    const pushToken = (await ui.push.createToken('curl')) as { token: string };
    const s = await openSocket();
    hello(s, pushToken.token);
    await s.waitFor(() => s.texts.some((m) => m.t === 'bye'));
    assert.deepEqual(s.texts.at(-1), { t: 'bye', reason: 'unauthorized' });
    const { token } = await pairedToken('Phone');
    const res = await fetch(`http://127.0.0.1:${WEBUI_PORT}/api/push/a`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'x' }),
    });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { code: string }).code, 'insufficient_scope');
  });

  await test('revoking a device kicks its page with bye revoked', async () => {
    const { token, deviceId } = await pairedToken('Tab');
    const s = await openSocket();
    hello(s, token);
    await s.waitFor(() => s.texts.some((m) => m.t === 'welcome'));
    assert.equal(admin.revoke(deviceId), null);
    // the wiring turns tokenRevoked into hub.kick; do it by hand here
    hub.kick(deviceId, 'revoked');
    await s.waitFor(() => s.texts.some((m) => m.t === 'bye'));
    assert.deepEqual(s.texts.at(-1), { t: 'bye', reason: 'revoked' });
  });

  console.log('\ndeck server: lifecycle');

  await test('stop() frees the port: the same server can start again', async () => {
    const { token } = await pairedToken('Again');
    const s = await openSocket();
    hello(s, token);
    await s.waitFor(() => s.texts.some((m) => m.t === 'welcome'));
    hub.closeAll('disabled');
    await s.waitFor(() => s.texts.some((m) => m.t === 'bye'));
    await deck.stop();
    assert.equal(deck.listening, false);
    let refused = false;
    try {
      await fetch(`${base}/deck/`);
    } catch {
      refused = true;
    }
    assert.ok(refused, 'the port must be closed after stop()');
    deck = mkServer();
    await deck.start();
    const page = await fetch(`${base}/deck/`);
    assert.equal(page.status, 200);
    await page.text();
  });

  await test('a port already in use throws on start and reports lastError', async () => {
    const dup = mkServer();
    let threw = false;
    try {
      await dup.start();
    } catch {
      threw = true;
    }
    assert.ok(threw, 'start() must throw when the port is taken');
    assert.ok(dup.lastError);
  });
} finally {
  await deck.stop();
  await ui.stop();
  await settings.close();
}

summaryExit();
