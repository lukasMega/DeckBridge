import assert from 'tjs:assert';
import { ElgatoServer, ElgatoChildServer } from '../src/elgato.js';
import { ELGATO_VID, ELGATO_PKT_SIZE_RX, NETWORK_DOCK_PID } from '../src/types.js';
import { MK2_CHILD_GEOMETRY, MINI_CHILD_GEOMETRY } from '../src/capabilities.js';
import {
  CORA_MAGIC,
  encodeCoraFrame,
  CORA_FLAG_RESULT,
  CORA_FLAG_VERBATIM,
  CORA_FLAG_REQACK,
  type CoraFrame,
} from '../src/cora-frame.js';
import { connect, sendPkt, closeAndWait } from './helpers/cora-framer.js';

const TEST_PORT = 15343;
const TEST_CHILD_PORT = 15344;

// ── Setup / teardown ─────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function runTest(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

const server = new ElgatoServer(TEST_PORT, true);
server.keepaliveIntervalMs = 100;
const childServer = new ElgatoChildServer(TEST_CHILD_PORT, server.deviceConfig, false);
childServer.keepaliveIntervalMs = 100;

await server.start();
await childServer.start();

try {
  // ── Post-start server error handling (L6) ────────────────────────────────

  console.log('\nelgato server: post-start error handling');

  await runTest('post-start server error is logged, not swallowed', () => {
    const logs: { level: string; component: string; message: string }[] = [];
    const onServerLog = (entry: { level: string; component: string; message: string }): void => {
      logs.push(entry);
    };
    server.on('serverLog', onServerLog);
    try {
      // After start(), the bootstrap error handler must log instead of
      // rejecting an already-settled promise. Reach into the underlying
      // NodeLikeServer's registered error callbacks and invoke the one
      // installed by startServer().
      const netServer = (server as unknown as { server: { _errorCbs: Array<(e: Error) => void> } })
        .server;
      assert.ok(netServer._errorCbs.length > 0, 'expected at least one registered error handler');
      const err = new Error('synthetic post-start accept error');
      for (const cb of netServer._errorCbs) cb(err);

      const errorLogs = logs.filter((l) => l.level === 'error');
      assert.equal(errorLogs.length, 1, 'expected exactly one error-level serverLog');
      assert.equal(errorLogs[0]!.component, 'elgato');
      assert.ok(/server error after start/.test(errorLogs[0]!.message));
      assert.ok(errorLogs[0]!.message.includes(err.message));
    } finally {
      server.off('serverLog', onServerLog);
    }
  });

  // ── Primary server tests ──────────────────────────────────────────────────

  console.log('\nelgato server: keepalive');

  await runTest('first packet is keepalive [01 0A ...]', async () => {
    const f = await connect(TEST_PORT);
    const frame = await f.recv();
    await closeAndWait(server, f);
    assert.equal(frame.payload[0], 0x01);
    assert.equal(frame.payload[1], 0x0a);
  });

  await runTest('keepalive sequence increments', async () => {
    const f = await connect(TEST_PORT);
    const keepalives: CoraFrame[] = [];
    while (keepalives.length < 3) {
      const frame = await f.recv(3000);
      if (frame.payload[0] === 0x01 && frame.payload[1] === 0x0a && frame.payload.length === 32) {
        keepalives.push(frame);
      }
    }
    await closeAndWait(server, f);
    const seq1 = keepalives[0]!.payload[5]!;
    assert.equal(keepalives[1]!.payload[5], (seq1 + 1) & 0xff);
    assert.equal(keepalives[2]!.payload[5], (seq1 + 2) & 0xff);
  });

  console.log('\nelgato server: feature reports');

  await runTest('device info (0x80) response has correct VID and Network Dock PID', async () => {
    const f = await connect(TEST_PORT);
    await f.recv(); // drain keepalive
    await sendPkt(f, 0x03, 0x80);
    const frame = await f.recv();
    await closeAndWait(server, f);
    assert.equal(frame.payload[0], 0x03);
    assert.equal(frame.payload[1], 0x80);
    assert.equal(frame.payload.readUInt16LE(12), ELGATO_VID);
    assert.equal(frame.payload.readUInt16LE(14), NETWORK_DOCK_PID);
  });

  await runTest('feature report 0x05 returns firmware version string', async () => {
    const f = await connect(TEST_PORT);
    await f.recv(); // drain keepalive
    await sendPkt(f, 0x03, 0x05);
    const frame = await f.recv();
    await closeAndWait(server, f);
    const str = Buffer.from(frame.payload.subarray(2, 2 + 8)).toString('ascii');
    assert.equal(str, '1.01.016');
  });

  await runTest('feature report 0x06 returns serial string', async () => {
    const f = await connect(TEST_PORT);
    await f.recv(); // drain keepalive
    await sendPkt(f, 0x03, 0x06);
    const frame = await f.recv();
    await closeAndWait(server, f);
    const prefix = Buffer.from(frame.payload.subarray(2, 2 + 4)).toString('ascii');
    assert.equal(prefix, 'A7FZ');
  });

  await runTest('0x1c capabilities response includes model name and correct port', async () => {
    const f = await connect(TEST_PORT);
    await f.recv(); // drain keepalive
    await sendPkt(f, 0x03, 0x1c);
    const frame = await f.recv();
    await closeAndWait(server, f);
    assert.equal(frame.payload[0], 0x01);
    assert.equal(frame.payload[1], 0x0b);
    assert.equal(frame.payload[4], 0x02);
    assert.equal(frame.payload[5], 3); // columns
    assert.equal(frame.payload[6], 5); // rows
    assert.equal(frame.payload[7], 15); // key count
    assert.equal(frame.payload.readUInt16LE(26), ELGATO_VID);
    assert.equal(frame.payload.readUInt16LE(28), server.deviceConfig.productId);
    const model = Buffer.from(frame.payload.subarray(62, 94)).toString('ascii').split('\0')[0];
    assert.equal(model, 'Stream Deck MK.2');
    assert.equal(frame.payload.readUInt16LE(126), 5344);
  });

  await runTest('responds with Result when ReqAck flag is set', async () => {
    const f = await connect(TEST_PORT);
    await f.recv(); // drain keepalive
    const msgId = 42;
    await sendPkt(f, 0x03, 0x80, { flags: CORA_FLAG_REQACK, messageId: msgId });
    const resultFrame = await f.recv();
    await closeAndWait(server, f);
    assert.ok(resultFrame.flags & CORA_FLAG_RESULT);
    assert.equal(resultFrame.messageId, msgId);
    assert.equal(resultFrame.payload[0], 0x03);
    assert.equal(resultFrame.payload[1], 0x80);
  });

  console.log('\nelgato server: connection management');

  await runTest('second client replaces first connection', async () => {
    const prevGrace = server.evictionGraceMs;
    server.evictionGraceMs = 0;
    const f1 = await connect(TEST_PORT);
    await f1.recv(); // drain keepalive — s1 holds the slot

    // Connect second client while first is still alive
    const f2 = await connect(TEST_PORT);

    // Second should receive keepalive
    const frame = await f2.recv();
    assert.equal(frame.payload[0], 0x01);
    assert.equal(frame.payload[1], 0x0a);

    // Brief yield so server's destroy(f1) fully propagates before we proceed
    await new Promise<void>((res) => setTimeout(res, 50));

    await closeAndWait(server, f2);
    server.evictionGraceMs = prevGrace;
  });

  await runTest('active client cannot be evicted within grace period', async () => {
    const prevGrace = server.evictionGraceMs;
    const f1 = await connect(TEST_PORT);
    await f1.recv(); // drain keepalive — also marks f1 as recently active

    // Connect second client while first is still active (default grace applies)
    const f2 = await connect(TEST_PORT);

    // f2's socket should be closed by the server (rejected takeover)
    let f2Rejected = false;
    try {
      await f2.recv(500);
    } catch {
      f2Rejected = true;
    }
    assert.ok(f2Rejected);

    // f1 is still the active client and keeps receiving keepalives
    const frame = await f1.recv(3000);
    assert.equal(frame.payload[0], 0x01);
    assert.equal(frame.payload[1], 0x0a);

    server.evictionGraceMs = prevGrace;
    await closeAndWait(server, f1);
  });

  await runTest('stale client (no traffic past grace) is evicted by newcomer', async () => {
    const prevGrace = server.evictionGraceMs;
    server.evictionGraceMs = 50;

    const f1 = await connect(TEST_PORT);
    await f1.recv(); // drain keepalive — sets lastClientRxTs

    // Wait past the grace period with no further traffic from f1
    await new Promise<void>((res) => setTimeout(res, 80));

    const f2 = await connect(TEST_PORT);
    const frame = await f2.recv();
    assert.equal(frame.payload[0], 0x01);
    assert.equal(frame.payload[1], 0x0a);

    await new Promise<void>((res) => setTimeout(res, 50));

    server.evictionGraceMs = prevGrace;
    await closeAndWait(server, f2);
  });

  await runTest('server does not OOM with large garbage data', async () => {
    const f = await connect(TEST_PORT);
    await f.recv(); // drain keepalive

    const garbage = Buffer.alloc(200 * 1024);
    for (let i = 0; i < garbage.length; i++) garbage[i] = (i * 7 + 3) & 0xff;
    for (let i = 0; i < garbage.length - 4; i++) {
      if (
        garbage[i] === CORA_MAGIC[0] &&
        garbage[i + 1] === CORA_MAGIC[1] &&
        garbage[i + 2] === CORA_MAGIC[2] &&
        garbage[i + 3] === CORA_MAGIC[3]
      ) {
        garbage[i] = (garbage[i] as number) ^ 1;
      }
    }
    await f.write(garbage);
    await sendPkt(f, 0x03, 0x80);
    // keepaliveIntervalMs is 100ms in tests, so several [01 0A ...] keepalive frames
    // can interleave before the [03 80] device-info reply — skip them.
    let frame = await f.recv(3000);
    while (frame.payload[0] === 0x01) frame = await f.recv(3000);
    await closeAndWait(server, f);
    assert.equal(frame.payload[0], 0x03);
    assert.equal(frame.payload[1], 0x80);
    assert.equal(frame.payload.readUInt16LE(12), ELGATO_VID);
  });

  // ── Child server tests ────────────────────────────────────────────────────

  console.log('\nelgato child server');

  await runTest('sendKeyEvent produces correct packet', async () => {
    const f = await connect(TEST_CHILD_PORT);
    await f.recv(); // drain keepalive

    childServer.sendKeyEvent(5, 'down');
    const frame1 = await f.recv();
    assert.equal(frame1.payload[0], 0x01);
    assert.equal(frame1.payload[1], 0x00);
    assert.equal(frame1.payload[4 + 5], 0x01);
    for (let i = 0; i < 15; i++) {
      if (i !== 5) assert.equal(frame1.payload[4 + i], 0x00);
    }

    childServer.sendKeyEvent(5, 'up');
    const frame2 = await f.recv();
    assert.equal(frame2.payload[4 + 5], 0x00);

    await closeAndWait(childServer, f);
  });

  /* oxlint-disable no-console no-control-regex */
  await runTest('GET_REPORT 0x05 returns child firmware version', async () => {
    const f = await connect(TEST_CHILD_PORT);
    await f.recv(); // drain keepalive

    const payload = Buffer.alloc(ELGATO_PKT_SIZE_RX);
    payload[0] = 0x05;
    await f.write(encodeCoraFrame(payload, CORA_FLAG_VERBATIM | CORA_FLAG_REQACK, 0x02, 1));

    const resp = await f.recv();
    await closeAndWait(childServer, f);

    assert.ok(resp.flags & CORA_FLAG_RESULT);
    assert.ok(resp.flags & CORA_FLAG_VERBATIM);
    assert.equal(resp.payload[0], 0x05);
    assert.equal(resp.payload[1], 0x0c);
    assert.notEqual(resp.payload.readUInt32BE(2), 0);
    assert.equal(
      Buffer.from(resp.payload.subarray(6, 6 + 8))
        .toString('ascii')
        // eslint-disable-next-line sonarjs/super-linear-regex
        .replace(/\0+$/, ''),
      '1.01.000',
    );
  });

  await runTest('GET_REPORT 0x06 returns child serial number', async () => {
    const f = await connect(TEST_CHILD_PORT);
    await f.recv(); // drain keepalive

    const payload = Buffer.alloc(ELGATO_PKT_SIZE_RX);
    payload[0] = 0x06;
    await f.write(encodeCoraFrame(payload, CORA_FLAG_VERBATIM | CORA_FLAG_REQACK, 0x02, 2));

    const resp = await f.recv();
    await closeAndWait(childServer, f);

    assert.ok(resp.flags & CORA_FLAG_RESULT);
    assert.ok(resp.flags & CORA_FLAG_VERBATIM);
    assert.equal(resp.payload[0], 0x06);
    assert.equal(resp.payload[1], 12);
    const serial = Buffer.from(resp.payload.subarray(2, 2 + 12)).toString('ascii');
    assert.equal(serial, 'A7FZA5191ILS');
  });

  await runTest('setChildGeometry always reallocates keyStates, preserving prefix (E4)', () => {
    // Start from a known small geometry, set a key, then grow to a larger geometry.
    childServer.setChildGeometry(MINI_CHILD_GEOMETRY); // keyCount 6
    const small = (childServer as unknown as { keyStates: Uint8Array }).keyStates;
    assert.equal(small.length, MINI_CHILD_GEOMETRY.keyCount);
    small[2] = 1; // mark key 2 as down directly on the array

    childServer.setChildGeometry(MK2_CHILD_GEOMETRY); // keyCount 15
    const large = (childServer as unknown as { keyStates: Uint8Array }).keyStates;
    assert.equal(large.length, MK2_CHILD_GEOMETRY.keyCount);
    assert.equal(large[2], 1, 'prefix should be preserved across resize');

    // Restore default geometry for any later tests / cleanliness.
    childServer.setChildGeometry(MK2_CHILD_GEOMETRY);
  });

  await runTest('GET_REPORT 0x0B returns device info', async () => {
    const f = await connect(TEST_CHILD_PORT);
    await f.recv(); // drain keepalive

    const payload = Buffer.alloc(ELGATO_PKT_SIZE_RX);
    payload[0] = 0x0b;
    await f.write(encodeCoraFrame(payload, CORA_FLAG_VERBATIM | CORA_FLAG_REQACK, 0x02, 3));

    const resp = await f.recv();
    await closeAndWait(childServer, f);

    assert.ok(resp.flags & CORA_FLAG_RESULT);
    assert.ok(resp.flags & CORA_FLAG_VERBATIM);
    assert.equal(resp.payload[0], 0x0b);
    assert.equal(resp.payload.readUInt16LE(2), ELGATO_VID);
    assert.equal(resp.payload.readUInt16LE(4), server.deviceConfig.productId);
  });
} finally {
  await server.stop();
  await childServer.stop();
}

// ── Child server: client takeover does not trigger outbound reconnect (E3) ──

const TAKEOVER_CHILD_PORT = 15346;

console.log('\nelgato child server: takeover race (E3)');

{
  const takeoverServer = new ElgatoServer(15345, true);
  takeoverServer.keepaliveIntervalMs = 100;
  const takeoverChildServer = new ElgatoChildServer(
    TAKEOVER_CHILD_PORT,
    takeoverServer.deviceConfig,
    true, // enableOutboundReconnect
  );
  takeoverChildServer.keepaliveIntervalMs = 100;
  takeoverChildServer.evictionGraceMs = 0;

  await takeoverServer.start();
  await takeoverChildServer.start();

  try {
    await runTest('client takeover does not start an outbound reconnect', async () => {
      const logs: { level: string; message: string }[] = [];
      const onServerLog = (entry: { level: string; message: string }): void => {
        logs.push(entry);
      };
      takeoverChildServer.on('serverLog', onServerLog);
      try {
        // Client A connects — sets remoteAddress and becomes the active client.
        const fA = await connect(TAKEOVER_CHILD_PORT);
        await fA.recv(); // drain keepalive

        // Client B takes over (evictionGraceMs = 0 allows immediate takeover).
        const fB = await connect(TAKEOVER_CHILD_PORT);
        await fB.recv(); // drain keepalive — B is now the active client

        // Give the deferred close microtask + any synchronous handlers a chance to run.
        await new Promise<void>((res) => setTimeout(res, 50));

        const outboundSocket = (takeoverChildServer as unknown as { outboundSocket: unknown })
          .outboundSocket;
        assert.equal(outboundSocket, null, 'no outbound socket should have been created');
        assert.ok(
          !logs.some((l) => l.message.includes('child outbound connect')),
          'no "child outbound connect" log should have been emitted',
        );

        await closeAndWait(takeoverChildServer, fB);
      } finally {
        takeoverChildServer.off('serverLog', onServerLog);
      }
    });
  } finally {
    await takeoverServer.stop();
    await takeoverChildServer.stop();
  }
}

// ── startCoraWithRetry (H3) ──────────────────────────────────────────────────

console.log('\nstartCoraWithRetry');

class FakeCoraServer implements CoraStartable {
  failuresRemaining: number;
  startCalls = 0;
  stopCalls = 0;

  constructor(failuresRemaining: number) {
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
}

await runTest('retries on bind failure, logs conflict, and eventually succeeds', async () => {
  const server2 = new FakeCoraServer(2); // fails twice, then succeeds
  const childServer2 = new FakeCoraServer(0);
  const logs: { level: string; component: string; message: string }[] = [];
  const webuiLogs: { level: string; component: string; message: string }[] = [];

  await startCoraWithRetry(
    {
      server: server2,
      childServer: childServer2,
      log: (level, component, message) => logs.push({ level, component, message }),
      webuiLog: (level, component, message) => webuiLogs.push({ level, component, message }),
      getShuttingDown: () => false,
      elgatoTcpPort: 5343,
      elgatoChildPort: 5344,
    },
    1, // short retry delay
  );

  // 2 failed attempts + 1 successful attempt
  assert.equal(server2.startCalls, 3);
  assert.equal(childServer2.startCalls, 1, 'childServer only starts after primary succeeds');
  // stop() called for cleanup after each failed attempt
  assert.equal(server2.stopCalls, 2);
  assert.equal(childServer2.stopCalls, 2);

  const errorLogs = logs.filter((l) => l.level === 'error');
  assert.equal(errorLogs.length, 2, 'one error log per failed attempt');
  assert.ok(errorLogs[0]!.message.includes('5343/5344'));
  assert.ok(errorLogs[0]!.message.includes('attempt 1'));
  assert.ok(errorLogs[1]!.message.includes('attempt 2'));
  assert.equal(webuiLogs.length, 2, 'one webui conflict log per failed attempt');
  assert.ok(webuiLogs[0]!.message.includes('is another DeckBridge / Elgato dock running?'));
});

await runTest('bails immediately if shutdown is already in progress', async () => {
  const server2 = new FakeCoraServer(5);
  const childServer2 = new FakeCoraServer(5);
  const logs: { level: string; component: string; message: string }[] = [];

  await startCoraWithRetry(
    {
      server: server2,
      childServer: childServer2,
      log: (level, component, message) => logs.push({ level, component, message }),
      webuiLog: () => {},
      getShuttingDown: () => true,
      elgatoTcpPort: 5343,
      elgatoChildPort: 5344,
    },
    1,
  );

  assert.equal(server2.startCalls, 0, 'should not attempt to start once shutting down');
  assert.equal(logs.length, 0);
});

// Trigger shutdown after the first failed attempt's retry delay by racing a
// second invocation that flips the flag once the first attempt has happened.
await runTest('shuttingDown flag set during wait stops further retries', async () => {
  const server2 = new FakeCoraServer(10);
  const childServer2 = new FakeCoraServer(0);
  let shuttingDown = false;

  const p = startCoraWithRetry(
    {
      server: server2,
      childServer: childServer2,
      log: () => {},
      webuiLog: () => {},
      getShuttingDown: () => shuttingDown,
      elgatoTcpPort: 5343,
      elgatoChildPort: 5344,
    },
    20,
  );

  // Let the first attempt fail and enter its retry wait, then signal shutdown.
  await new Promise((r) => setTimeout(r, 5));
  shuttingDown = true;
  await p;

  assert.ok(server2.startCalls >= 1 && server2.startCalls < 10, 'stopped retrying after shutdown');
});

// ── WebUIServer: POST /api/brightness ────────────────────────────────────────

import { WebUIServer } from '../src/web/server/index.js';
import { startCoraWithRetry, type CoraStartable } from '../src/cora-startup.js';

const WEBUI_TEST_PORT = 13001;
const webui = new WebUIServer(WEBUI_TEST_PORT);
await webui.start();

console.log('\nwebui: POST /api/brightness');

try {
  const webuiBase = `http://127.0.0.1:${webui.port}`;

  await runTest('valid level → 200 ok, brightness reflected in snapshot', async () => {
    const r = await fetch(`${webuiBase}/api/brightness`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 75 }),
    });
    assert.equal(r.status, 200);
    const body = (await r.json()) as { ok: unknown; level: unknown };
    assert.ok(body.ok);
    assert.equal(body.level, 75);
    assert.equal(webui.snapshot().brightness, 75);
  });

  await runTest('level rounds to integer', async () => {
    const r = await fetch(`${webuiBase}/api/brightness`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 50.9 }),
    });
    assert.equal(r.status, 200);
    const body = (await r.json()) as { level: number };
    assert.equal(body.level, 51);
  });

  await runTest('level > 100 → 400', async () => {
    const r = await fetch(`${webuiBase}/api/brightness`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 101 }),
    });
    assert.equal(r.status, 400);
  });

  await runTest('level < 0 → 400', async () => {
    const r = await fetch(`${webuiBase}/api/brightness`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: -1 }),
    });
    assert.equal(r.status, 400);
  });

  await runTest('non-numeric level → 400', async () => {
    const r = await fetch(`${webuiBase}/api/brightness`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'high' }),
    });
    assert.equal(r.status, 400);
  });

  await runTest('invalid JSON body → 400', async () => {
    const r = await fetch(`${webuiBase}/api/brightness`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    assert.equal(r.status, 400);
  });
} finally {
  await webui.stop().catch(() => undefined);
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
tjs.exit(failed > 0 ? 1 : 0);
