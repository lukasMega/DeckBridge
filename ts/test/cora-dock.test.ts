import assert from 'tjs:assert';
import { EventEmitter } from 'node:events';
import { CoraDock } from '../src/main/cora-dock.js';
import type { ElgatoServer } from '../src/cora/primary-server.js';
import type { ElgatoChildServer } from '../src/cora/child-server.js';
import { ElgatoChildServer as RealChildServer } from '../src/cora/child-server.js';
import { modelToChildGeometry } from '../src/devices/registry.js';
import { MK2_MODEL } from '../src/devices/elgato/mk2.js';
import {
  DEFAULT_CHILD_FIRMWARE_VERSION,
  DEFAULT_CHILD_SERIAL_NUMBER,
  DEFAULT_DOCK_FIRMWARE_VERSION,
  DEFAULT_DOCK_SERIAL_NUMBER,
  ELGATO_MK2_PID,
} from '../src/shared/types.js';
import { connect, sendFrame } from './helpers/cora-framer.js';
import { CORA_FLAG_VERBATIM } from '../src/cora/frame.js';
import { setLogLevel } from '../src/shared/logger.js';
import { testAsync as runTest, summary } from './helpers/harness.js';

setLogLevel('silent');

// Bind-conflict retry (was startCoraWithRetry, moved here as CoraDock.startWithRetry).

class FakeCoraServer extends EventEmitter {
  failuresRemaining: number;
  startCalls = 0;
  stopCalls = 0;
  hasClient = false;
  rxIdleMs = 0;

  constructor(failuresRemaining: number) {
    super();
    this.failuresRemaining = failuresRemaining;
  }

  start(): Promise<void> {
    this.startCalls++;
    if (this.failuresRemaining > 0) {
      this.failuresRemaining--;
      throw new Error('listen EADDRINUSE');
    }
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.stopCalls++;
    return Promise.resolve();
  }

  setDeviceConfig(): void {}
  setChildGeometry(): void {}
  restartMdns(): void {}
  pushChildCapabilities(): void {}
  setMdnsServiceName(): void {}
}

function makeDock(server: FakeCoraServer, childServer: FakeCoraServer): CoraDock {
  return new CoraDock(
    server as unknown as ElgatoServer,
    childServer as unknown as ElgatoChildServer,
    'test dock',
  );
}

console.log('\nCoraDock.startWithRetry');

await runTest('retries on bind failure, logs conflict, and eventually succeeds', async () => {
  const server = new FakeCoraServer(2); // fails twice, then succeeds
  const childServer = new FakeCoraServer(0);
  const dock = makeDock(server, childServer);
  const logs: { level: string; component: string; message: string }[] = [];

  await dock.startWithRetry({
    log: (level, component, message) => logs.push({ level, component, message }),
    getShuttingDown: () => false,
    primaryPort: 5343,
    childPort: 5344,
    delayMs: 1, // short retry delay
  });

  // 2 failed attempts + 1 successful attempt
  assert.equal(server.startCalls, 3);
  assert.equal(childServer.startCalls, 1, 'childServer only starts after primary succeeds');
  // stop() called for cleanup after each failed attempt
  assert.equal(server.stopCalls, 2);
  assert.equal(childServer.stopCalls, 2);

  const errorLogs = logs.filter((l) => l.level === 'error');
  assert.equal(errorLogs.length, 2, 'one error log per failed attempt');
  assert.ok(errorLogs[0]!.message.includes('5343/5344'));
  assert.ok(errorLogs[0]!.message.includes('attempt 1'));
  assert.ok(errorLogs[1]!.message.includes('attempt 2'));
});

await runTest('bails immediately if shutdown is already in progress', async () => {
  const server = new FakeCoraServer(5);
  const childServer = new FakeCoraServer(5);
  const dock = makeDock(server, childServer);
  const logs: { level: string; component: string; message: string }[] = [];

  await dock.startWithRetry({
    log: (level, component, message) => logs.push({ level, component, message }),
    getShuttingDown: () => true,
    primaryPort: 5343,
    childPort: 5344,
    delayMs: 1,
  });

  assert.equal(server.startCalls, 0, 'should not attempt to start once shutting down');
  assert.equal(logs.length, 0);
});

// Trigger shutdown after the first failed attempt's retry delay by racing a
// second invocation that flips the flag once the first attempt has happened.
await runTest('shuttingDown flag set during wait stops further retries', async () => {
  const server = new FakeCoraServer(10);
  const childServer = new FakeCoraServer(0);
  const dock = makeDock(server, childServer);
  let shuttingDown = false;

  const p = dock.startWithRetry({
    log: () => {},
    getShuttingDown: () => shuttingDown,
    primaryPort: 5343,
    childPort: 5344,
    delayMs: 20,
  });

  // Let the first attempt fail and enter its retry wait, then signal shutdown.
  await new Promise((r) => setTimeout(r, 5));
  shuttingDown = true;
  await p;

  assert.ok(server.startCalls >= 1 && server.startCalls < 10, 'stopped retrying after shutdown');
});

await runTest('maxAttempts exhausted rethrows the last bind error', async () => {
  const server = new FakeCoraServer(3); // never succeeds within 2 attempts
  const childServer = new FakeCoraServer(0);
  const dock = makeDock(server, childServer);

  let error: Error | null = null;
  try {
    await dock.startWithRetry({
      log: () => {},
      primaryPort: 5343,
      childPort: 5344,
      maxAttempts: 2,
      delayMs: 1,
    });
  } catch (e) {
    error = e as Error;
  }
  assert.ok(error, 'rethrows once maxAttempts is exhausted');
  assert.equal(server.startCalls, 2, 'stops after maxAttempts, does not loop forever');
});

await runTest('a single failed attempt (maxAttempts: 1) throws with no retry wait', async () => {
  const server = new FakeCoraServer(1);
  const childServer = new FakeCoraServer(0);
  const dock = makeDock(server, childServer);

  let error: Error | null = null;
  try {
    await dock.startWithRetry({
      log: () => {},
      primaryPort: 5345,
      childPort: 5346,
      maxAttempts: 1,
    });
  } catch (e) {
    error = e as Error;
  }
  assert.ok(error);
  assert.equal(server.startCalls, 1);
  assert.equal(server.stopCalls, 1, 'cleaned up the failed attempt');
});

// applyModel / stop

console.log('\nCoraDock.applyModel / stop');

await runTest('stop() cancels the pairing watchdog and stops both servers', async () => {
  const server = new FakeCoraServer(0);
  const childServer = new FakeCoraServer(0);
  const dock = makeDock(server, childServer);
  await dock.startWithRetry({ log: () => {}, primaryPort: 5343, childPort: 5344 });

  await dock.stop();

  assert.equal(server.stopCalls, 1);
  assert.equal(childServer.stopCalls, 1);
});

await runTest('stop() attempts both servers and rejects when one fails', async () => {
  const server = new FakeCoraServer(0);
  const childServer = new FakeCoraServer(0);
  server.stop = () => Promise.reject(new Error('primary stuck'));
  const dock = makeDock(server, childServer);
  let err: unknown;
  await dock.stop().catch((e: unknown) => (err = e));
  assert.ok(err instanceof Error && err.message.includes('primary stuck'));
  assert.equal(childServer.stopCalls, 1);
});

console.log('\nrx idle surface (standby CORA-silence)');

await runTest('childRxIdleMs forwards the child server getter', () => {
  const child = new FakeCoraServer(0);
  const dock = makeDock(new FakeCoraServer(0), child);
  assert.equal(dock.childRxIdleMs, 0);
  child.rxIdleMs = 1234;
  assert.equal(dock.childRxIdleMs, 1234);
});

await runTest('rxIdleMs is 0 without a client and grows after the last data', async () => {
  const port = 25601;
  const server = new RealChildServer(
    modelToChildGeometry(MK2_MODEL),
    port,
    {
      dockFirmwareVersion: DEFAULT_DOCK_FIRMWARE_VERSION,
      childFirmwareVersion: DEFAULT_CHILD_FIRMWARE_VERSION,
      serialNumber: DEFAULT_DOCK_SERIAL_NUMBER,
      childSerialNumber: DEFAULT_CHILD_SERIAL_NUMBER,
      productId: ELGATO_MK2_PID,
      macAddress: [0x02, 0x00, 0x00, 0x00, 0x00, 0x01],
    },
    false,
  );
  await server.start();
  try {
    assert.equal(server.rxIdleMs, 0, 'no client');
    const f = await connect(port);
    await f.recv(); // initial keepalive: the client socket is attached
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(server.rxIdleMs >= 60, `idle grows while the client is silent (${server.rxIdleMs})`);
    await sendFrame(f, Buffer.alloc(0), CORA_FLAG_VERBATIM, 0, 1);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(server.rxIdleMs < 60, `data resets the idle clock (${server.rxIdleMs})`);
    f.close();
  } finally {
    await server.stop();
  }
});

summary();
