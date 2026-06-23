import assert from 'tjs:assert';
import {
  isAllowedWebRequest,
  isValidMacAddress,
  pickFallbackPort,
  WebUIServer,
} from '../src/web/server/web-ui-server.js';
import { Broadcaster } from '../src/web/server/broadcaster.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

async function runWebTest(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

// ── isValidMacAddress ─────────────────────────────────────────────────────────

console.log('\nisValidMacAddress');

test('valid lowercase hex MAC → true', () => {
  assert.ok(isValidMacAddress('aa:bb:cc:dd:ee:ff'));
});

test('valid uppercase hex MAC → true', () => {
  assert.ok(isValidMacAddress('AA:BB:CC:DD:EE:FF'));
});

test('valid mixed-case hex MAC → true', () => {
  assert.ok(isValidMacAddress('aA:bB:cC:dD:eE:fF'));
});

test('valid all-zeros MAC → true', () => {
  assert.ok(isValidMacAddress('00:00:00:00:00:00'));
});

test('too few octets → false', () => {
  assert.ok(!isValidMacAddress('aa:bb:cc:dd:ee'));
});

test('too many octets → false', () => {
  assert.ok(!isValidMacAddress('aa:bb:cc:dd:ee:ff:00'));
});

test('non-hex character → false', () => {
  assert.ok(!isValidMacAddress('gg:bb:cc:dd:ee:ff'));
});

test('hyphen separator → false', () => {
  assert.ok(!isValidMacAddress('aa-bb-cc-dd-ee-ff'));
});

test('octet too long → false', () => {
  assert.ok(!isValidMacAddress('aaa:bb:cc:dd:ee:ff'));
});

test('octet too short → false', () => {
  assert.ok(!isValidMacAddress('a:bb:cc:dd:ee:ff'));
});

test('empty string → false', () => {
  assert.ok(!isValidMacAddress(''));
});

// ── isAllowedWebRequest ────────────────────────────────────────────────────────

console.log('\nisAllowedWebRequest');

test('localhost host, no origin → true', () => {
  assert.ok(isAllowedWebRequest('localhost:3000', null, 3000));
});

test('127.0.0.1 host, localhost origin → true', () => {
  assert.ok(isAllowedWebRequest('127.0.0.1:3000', 'http://localhost:3000', 3000));
});

test('[::1] host, no origin → true', () => {
  assert.ok(isAllowedWebRequest('[::1]:3000', null, 3000));
});

test('mixed-case host → true', () => {
  assert.ok(isAllowedWebRequest('LocalHost:3000', null, 3000));
});

test('null host → false', () => {
  assert.ok(!isAllowedWebRequest(null, null, 3000));
});

test('DNS-rebinding host → false', () => {
  assert.ok(!isAllowedWebRequest('evil.example:3000', null, 3000));
});

test('wrong port in host → false', () => {
  assert.ok(!isAllowedWebRequest('localhost:9999', null, 3000));
});

test('cross-site origin → false', () => {
  assert.ok(!isAllowedWebRequest('localhost:3000', 'https://evil.example', 3000));
});

test('wrong-port origin → false', () => {
  assert.ok(!isAllowedWebRequest('localhost:3000', 'http://localhost:4000', 3000));
});

test('bare host (no port), no origin → true', () => {
  assert.ok(isAllowedWebRequest('127.0.0.1', null, 3000));
});

test('bare host, bare origin → true', () => {
  assert.ok(isAllowedWebRequest('127.0.0.1', 'http://127.0.0.1', 3000));
});

// ── pickFallbackPort ──────────────────────────────────────────────────────────

console.log('\npickFallbackPort');

test('returns a port in the expected fallback range', () => {
  for (let i = 0; i < 50; i++) {
    const port = pickFallbackPort();
    assert.ok(port >= 64000 && port <= 65000, `port ${port} out of range`);
  }
});

// ── Broadcaster.size ──────────────────────────────────────────────────────────

console.log('\nBroadcaster.size');

function mockSocket(): ServerWebSocket {
  return {
    data: undefined,
    sendText: () => {},
    sendBinary: () => {},
    close: () => {},
  };
}

test('starts at 0 with no clients', () => {
  const bus = new Broadcaster();
  assert.equal(bus.size, 0);
});

test('increments on open, decrements on close', () => {
  const bus = new Broadcaster();
  const handlers = bus.websocketHandlers(() => {});
  const ws1 = mockSocket();
  const ws2 = mockSocket();

  handlers.open(ws1);
  assert.equal(bus.size, 1);

  handlers.open(ws2);
  assert.equal(bus.size, 2);

  handlers.close(ws1);
  assert.equal(bus.size, 1);

  handlers.close(ws2);
  assert.equal(bus.size, 0);
});

test('decrements on error', () => {
  const bus = new Broadcaster();
  const handlers = bus.websocketHandlers(() => {});
  const ws = mockSocket();

  handlers.open(ws);
  assert.equal(bus.size, 1);

  handlers.error(ws);
  assert.equal(bus.size, 0);
});

test('stop() clears all clients', () => {
  const bus = new Broadcaster();
  const handlers = bus.websocketHandlers(() => {});
  handlers.open(mockSocket());
  handlers.open(mockSocket());
  assert.equal(bus.size, 2);

  bus.stop();
  assert.equal(bus.size, 0);
});

// ── WebUIServer.resetImages ──────────────────────────────────────────────────

console.log('\nWebUIServer.resetImages');

test('clears imageState/imageVersion and broadcasts repaint', () => {
  const ui = new WebUIServer();
  ui.notifyImageUpdate(0, Buffer.from([1, 2, 3]));
  ui.notifyImageUpdate(1, Buffer.from([4, 5, 6]));
  assert.equal(ui.imageState.size, 2, 'two images set');
  assert.equal(Object.keys(ui.fullState().images).length, 2, 'fullState reports two images');

  let repaintBroadcast = false;
  const origBroadcast = (ui as unknown as { bus: { broadcast: (...a: unknown[]) => void } }).bus
    .broadcast;
  (ui as unknown as { bus: { broadcast: (...a: unknown[]) => void } }).bus.broadcast = (
    ...args: unknown[]
  ) => {
    if (args[0] === 'repaint') repaintBroadcast = true;
    return origBroadcast.apply(
      (ui as unknown as { bus: { broadcast: (...a: unknown[]) => void } }).bus,
      args,
    );
  };

  ui.resetImages();

  assert.equal(ui.imageState.size, 0, 'imageState cleared');
  assert.equal(Object.keys(ui.fullState().images).length, 0, 'fullState images empty');
  assert.ok(repaintBroadcast, 'repaint broadcast sent');
});

// ── WebUIServer.applyMockConfig productId ────────────────────────────────────

console.log('\nWebUIServer.applyMockConfig productId');

test('NaN productId leaves previous PID unchanged', () => {
  const ui = new WebUIServer();
  const before = ui.fullState().mockConfig.productId;
  const result = ui.applyMockConfig({ productId: Number.NaN });
  assert.equal(result.productId, before, 'productId unchanged for NaN');
});

test('valid integer productId is masked and applied', () => {
  const ui = new WebUIServer();
  const result = ui.applyMockConfig({ productId: 0x1234abcd });
  assert.equal(result.productId, 0x1234abcd & 0xffff, 'productId masked');
});

// ── WebUIServer: POST /api/image-mode ────────────────────────────────────────

console.log('\nwebui: POST /api/image-mode');

const IMAGE_MODE_TEST_PORT = 13002;
const imageModeUi = new WebUIServer(IMAGE_MODE_TEST_PORT);
await imageModeUi.start();

try {
  const base = `http://127.0.0.1:${imageModeUi.port}`;

  async function postImageMode(mode: unknown): Promise<Response> {
    return fetch(`${base}/api/image-mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
  }

  test('initial imageModeOverride is null', () => {
    assert.equal(imageModeUi.fullState().imageModeOverride, null);
  });

  await runWebTest('valid mode "pad-edge" → 200 ok, reflected in fullState', async () => {
    const r = await postImageMode('pad-edge');
    assert.equal(r.status, 200);
    const body = (await r.json()) as { ok: unknown; mode: unknown };
    assert.ok(body.ok);
    assert.equal(body.mode, 'pad-edge');
    assert.equal(imageModeUi.fullState().imageModeOverride, 'pad-edge');
  });

  await runWebTest("valid mode 'default' → 200 ok, fullState override → null", async () => {
    const r = await postImageMode('default');
    assert.equal(r.status, 200);
    const body = (await r.json()) as { ok: unknown; mode: unknown };
    assert.ok(body.ok);
    assert.equal(body.mode, 'default');
    assert.equal(imageModeUi.fullState().imageModeOverride, null);
  });

  for (const mode of ['resize', 'pad-black', 'pad-average']) {
    await runWebTest(`valid mode '${mode}' → 200 ok, reflected in fullState`, async () => {
      const r = await postImageMode(mode);
      assert.equal(r.status, 200);
      assert.equal(imageModeUi.fullState().imageModeOverride, mode);
    });
  }

  await runWebTest('invalid mode string → 400', async () => {
    const r = await postImageMode('sideways');
    assert.equal(r.status, 400);
  });

  await runWebTest('non-string mode → 400', async () => {
    const r = await postImageMode(123);
    assert.equal(r.status, 400);
  });

  await runWebTest('invalid JSON body → 400', async () => {
    const r = await fetch(`${base}/api/image-mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    assert.equal(r.status, 400);
  });
} finally {
  await imageModeUi.stop().catch(() => undefined);
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
tjs.exit(failed > 0 ? 1 : 0);
