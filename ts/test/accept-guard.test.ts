import assert from 'tjs:assert';
import { guardAccept, isDroppedAccept, KEEPALIVE_DELAY_S } from '../src/platform/accept-guard.js';
import { testAsync, summaryExit } from './helpers/harness.js';

const HOST = '127.0.0.1';
// Below 32768: Linux gives 32768-60999 to outgoing sockets, which caused EADDRINUSE.
const port = 20720 + (tjs.pid % 100);

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

/** Swap txiki's accept factory for a stub so the guard's wrapper can be driven with a fake handle. */
function stubFactory(server: TjsTCPServerSocket): Factory {
  (server as unknown as { _createAcceptedSocket: Factory })._createAcceptedSocket = () => ({});
  guardAccept(server);
  return (server as unknown as { _createAcceptedSocket: Factory })._createAcceptedSocket;
}

await testAsync('accepted socket handle gets noDelay and keepalive', async () => {
  const server = await tjs.listen('tcp', HOST, port + 2);
  try {
    const calls: string[] = [];
    const handle = {
      setNoDelay: (on: boolean) => calls.push(`nodelay ${on}`),
      setKeepAlive: (on: boolean, s: number) => calls.push(`keepalive ${on} ${s}`),
    };
    const result = stubFactory(server).call(server, Object, handle, () => ({}));
    assert.ok(result !== null, 'accept itself succeeds');
    assert.deepEqual(calls, ['nodelay true', `keepalive true ${KEEPALIVE_DELAY_S}`]);
  } finally {
    server.close();
  }
});

await testAsync('a throwing setNoDelay does not fail the accept', async () => {
  const server = await tjs.listen('tcp', HOST, port + 3);
  try {
    const handle = {
      setNoDelay: () => {
        throw new Error('ENOTCONN');
      },
    };
    assert.ok(stubFactory(server).call(server, Object, handle, () => ({})) !== null);
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
