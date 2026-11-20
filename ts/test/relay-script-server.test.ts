/* eslint-disable sonarjs/no-hardcoded-ip -- fixture addresses, nothing is contacted */
import assert from 'tjs:assert';
import { RELAY_SCRIPT_PATH, RELAY_SCRIPT_PORT } from '../src/web/server/relay-script.js';
import { deviceScript } from '../src/web/server/relay-script-device.js';
import { platformName } from '../src/infra/os-utils.js';
import { RelayScriptServer } from '../src/web/server/relay-script-server.js';
import { isPortInUse } from '../src/web/server/web-request-guard.js';
import { testAsync as test, summaryExit } from './helpers/harness.js';

console.log('\nrelay script server');

const TOKEN = 'a'.repeat(32);
// Hold the default port so the server must fall back (another process may already hold it).
const blocker = (await isPortInUse(RELAY_SCRIPT_PORT))
  ? null
  : tjs.serve({ port: RELAY_SCRIPT_PORT, listenIp: '127.0.0.1', fetch: () => new Response('') });
const logs: string[] = [];
const events: Array<{ stage: string; ip: string; selfIp?: string; t?: unknown }> = [];
let active: string | null = TOKEN;
const server = new RelayScriptServer({
  listenIp: '127.0.0.1',
  token: () => active,
  script: ({ token, port }) => `#!/bin/sh\n# ${token} ${port}\n`,
  onEvent: (ev, ip) => events.push({ ...ev, ip }),
  log: (_level, msg) => logs.push(msg),
});

const body = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    t: TOKEN,
    stage: 'running',
    platform: 'linux-arm64',
    version: '0.23.0',
    ...over,
  });

try {
  const port = await server.reservePort();
  const url = (path: string): string => `http://127.0.0.1:${port}${path}`;
  const send = async (init: RequestInit): Promise<Response> => {
    const res = await fetch(url('/relay/event'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...init,
    });
    await res.text();
    return res;
  };

  await test('a taken default port falls back to a free port the probe can report', async () => {
    assert.notEqual(port, RELAY_SCRIPT_PORT);
    assert.equal(await server.reservePort(), port, 'reserved port is stable');
    await server.start();
    assert.ok(server.listening);
    assert.ok(logs.some((m) => m.includes(String(port))));
  });

  await test('GET /relay.sh: 200 with the token, 404 without, wrong or on another path', async () => {
    const ok = await fetch(url(`${RELAY_SCRIPT_PATH}?t=${TOKEN}`));
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), `#!/bin/sh\n# ${TOKEN} ${port}\n`);
    for (const q of ['', '?t=', `?t=${'b'.repeat(32)}`, `?t=${TOKEN}x`]) {
      const res = await fetch(url(`${RELAY_SCRIPT_PATH}${q}`));
      assert.equal(res.status, 404, q);
      await res.text();
    }
    const other = await fetch(url(`/other?t=${TOKEN}`));
    assert.equal(other.status, 404);
    await other.text();
  });

  await test('POST /relay/event: 204 ok, 403 bad token, 400 bad body, 404 on GET', async () => {
    assert.equal((await send({ body: body() })).status, 204);
    assert.equal((await send({ body: body({ t: 'b'.repeat(32) }) })).status, 403);
    assert.equal((await send({ body: body({ stage: 'offline' }) })).status, 400);
    assert.equal((await send({ body: 'not json' })).status, 400);
    assert.equal((await send({ body: body({ message: 'x'.repeat(2000) }) })).status, 400);
    const get = await fetch(url('/relay/event'));
    assert.equal(get.status, 404);
    await get.text();
  });

  await test('the reported ip is the socket peer, never a body field', async () => {
    events.length = 0;
    assert.equal((await send({ body: body({ ip: '10.9.9.9' }) })).status, 204);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.ip, '127.0.0.1');
    assert.equal(events[0]!.t, undefined, 'the token stays in the server');
  });

  await test('a LAN selfIp reaches the route state next to the peer ip', async () => {
    events.length = 0;
    assert.equal((await send({ body: body({ selfIp: '192.168.139.155' }) })).status, 204);
    assert.equal(events[0]!.selfIp, '192.168.139.155');
    assert.equal(events[0]!.ip, '127.0.0.1');
  });

  await test('30 events a minute; bad tokens do not use the budget', async () => {
    const fresh = new RelayScriptServer({
      listenIp: '127.0.0.1',
      token: () => TOKEN,
      script: () => '',
      onEvent: () => undefined,
    });
    await fresh.start();
    const p = await fresh.reservePort();
    const post = async (b: string): Promise<number> => {
      const res = await fetch(`http://127.0.0.1:${p}/relay/event`, { method: 'POST', body: b });
      await res.text();
      return res.status;
    };
    try {
      for (let i = 0; i < 5; i++) assert.equal(await post(body({ t: 'c'.repeat(32) })), 403);
      for (let i = 0; i < 30; i++) assert.equal(await post(body()), 204);
      assert.equal(await post(body()), 429);
    } finally {
      await fresh.stop();
    }
  });

  await test('the real script reports a failed install to the listener and exits 1', async () => {
    if (platformName() === 'Windows') return;
    events.length = 0;
    // Release 0.0.1 does not exist (and offline fails the same way): the download step fails.
    const script = deviceScript({
      version: '0.0.1',
      target: '127.0.0.1',
      targetPort: 5343,
      scriptPort: port,
      token: TOKEN,
    });
    const home = `${tjs.tmpDir}/relay-script-home-${tjs.pid}`;
    await tjs.makeDir(home, { recursive: true });
    const proc = tjs.spawn(['sh', '-s'], {
      env: { ...tjs.env, HOME: home },
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const w = proc.stdin.getWriter();
    await w.write(new TextEncoder().encode(script));
    await w.close();
    const { exit_status } = await proc.wait();
    await tjs.remove(home).catch(() => undefined);
    assert.equal(exit_status, 1);
    assert.deepEqual(
      events.map((e) => e.stage),
      ['downloading', 'failed'],
    );
  });

  await test('an inactive route 404s everything', async () => {
    active = null;
    const res = await fetch(url(`${RELAY_SCRIPT_PATH}?t=${TOKEN}`));
    assert.equal(res.status, 404);
    await res.text();
    assert.equal((await send({ body: body() })).status, 404);
    active = TOKEN;
  });

  await test('stop then start keeps the same port, so a copied command stays valid', async () => {
    await server.stop();
    await server.start();
    assert.equal(await server.reservePort(), port);
    const res = await fetch(url(`${RELAY_SCRIPT_PATH}?t=${TOKEN}`));
    assert.equal(res.status, 200);
    await res.text();
  });
} finally {
  await server.stop();
  await blocker?.close();
}

summaryExit();
