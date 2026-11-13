import assert from 'tjs:assert';
import { RELAY_SCRIPT_PATH, RELAY_SCRIPT_PORT } from '../src/web/server/relay-script.js';
import { RelayScriptServer } from '../src/web/server/relay-script-server.js';
import { isPortInUse } from '../src/web/server/web-request-guard.js';
import { testAsync as test, summaryExit } from './helpers/harness.js';

console.log('\nrelay script server');

// Hold the default port so the server must fall back (another process may already hold it).
const blocker = (await isPortInUse(RELAY_SCRIPT_PORT))
  ? null
  : tjs.serve({ port: RELAY_SCRIPT_PORT, listenIp: '127.0.0.1', fetch: () => new Response('') });
const logs: string[] = [];
const server = new RelayScriptServer({
  listenIp: '127.0.0.1',
  script: () => '#!/bin/sh\n',
  log: (_level, msg) => logs.push(msg),
});

try {
  await test('a taken default port falls back to a free port the probe can report', async () => {
    const port = await server.reservePort();
    assert.notEqual(port, RELAY_SCRIPT_PORT);
    assert.equal(await server.reservePort(), port, 'reserved port is stable');
    await server.start();
    assert.ok(server.listening);
    const res = await fetch(`http://127.0.0.1:${port}${RELAY_SCRIPT_PATH}`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '#!/bin/sh\n');
    assert.ok(logs.some((m) => m.includes(String(port))));
  });

  await test('stop then start keeps the same port, so a copied command stays valid', async () => {
    const port = await server.reservePort();
    await server.stop();
    await server.start();
    assert.equal(await server.reservePort(), port);
    const res = await fetch(`http://127.0.0.1:${port}${RELAY_SCRIPT_PATH}`);
    assert.equal(res.status, 200);
    await res.text();
  });
} finally {
  await server.stop();
  await blocker?.close();
}

summaryExit();
