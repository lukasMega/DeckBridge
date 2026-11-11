import assert from 'tjs:assert';
import { guardAccept, isDroppedAccept } from '../src/platform/accept-guard.js';
import { testAsync, summaryExit } from './helpers/harness.js';

const HOST = '127.0.0.1';
const port = 48720 + (tjs.pid % 100);

type Factory = (...args: unknown[]) => unknown;

await testAsync('guarded accept drops a handle whose getpeername throws', async () => {
  const server = await tjs.listen('tcp', HOST, port);
  guardAccept(server);
  try {
    let closed = 0;
    const handle = {
      getsockname: () => ({ ip: HOST, port }),
      getpeername: () => {
        throw new Error('EINVAL: invalid argument');
      },
      close: () => {
        closed++;
      },
    };
    const factory = (server as unknown as { _createAcceptedSocket: Factory })._createAcceptedSocket;
    const result = factory.call(server, Object, handle, () => ({})) as TjsAcceptedTCPSocket | null;
    assert.ok(isDroppedAccept(result), 'yields null instead of throwing');
    assert.equal(closed, 1, 'closes the dropped handle');
  } finally {
    server.close();
  }
});

await testAsync('guarded server still accepts a normal client', async () => {
  const server = await tjs.listen('tcp', HOST, port + 1);
  guardAccept(server);
  try {
    const reader = (await server.opened).readable.getReader();
    const client = await tjs.connect('tcp', HOST, port + 1);
    await client.opened;
    const { value: conn } = await reader.read();
    if (conn === undefined || isDroppedAccept(conn)) throw new Error('expected a socket');
    const info = await conn.opened;
    assert.equal(info.remoteAddress, HOST);
    conn.close();
    client.close();
    reader.releaseLock();
  } finally {
    server.close();
  }
});

summaryExit();
