import assert from 'tjs:assert';
import { EventEmitter } from '../src/platform/events-shim.js';
import { WebUIServer } from '../src/web/server/web-ui-server.js';
import { PersistedSettings } from '../src/infra/settings.js';
import { CoraDock } from '../src/main/cora-dock.js';
import type { Dock, DockHooks } from '../src/main/dock.js';
import type { ElgatoServer } from '../src/cora/primary-server.js';
import type { ElgatoChildServer } from '../src/cora/child-server.js';
import {
  VIRTUAL_DECK_DEVICE_KEY,
  VIRTUAL_DOCK_PORTS,
  VirtualDock,
} from '../src/main/virtual-deck/virtual-dock.js';
import { DECK_PROTOCOL_VERSION } from '../src/web/server/virtual-deck/deck-constants.js';
import { ELGATO_TCP_PORT, VIRTUAL_DOCK_INDEX } from '../src/shared/types.js';
import { testAsync as test, summaryExit } from './helpers/harness.js';

const ROOT = `${tjs.tmpDir}/virtual-dock-test-${tjs.pid}`;
const DECK_PORT = 13071;

class FakeServer extends EventEmitter {
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  setDeviceConfig(): void {}
  setChildGeometry(): void {}
  restartMdns(): void {}
  pushChildCapabilities(): void {}
  setMdnsServiceName(): void {}
}
class FakeChild extends FakeServer {
  hasClient = false;
  keys: string[] = [];
  sendKeyEvent(k: number, s: string): void {
    this.keys.push(`${k}:${s}`);
  }
}

const settings = new PersistedSettings(ROOT);
await settings.load();
const ui = new WebUIServer(13070, [], 'real', settings);
await ui.start();
const controller = ui.virtualDeck;

const registered = new Map<number, Dock>();
const removed: number[] = [];
let changed = 0;
const hooks: DockHooks = { changed: () => changed++ };
const children: FakeChild[] = [];
const dock3 = new VirtualDock({
  controller,
  settings,
  host: {
    hooksForDock: () => hooks,
    addExternalDock: (d) => registered.set(d.index, d),
    removeExternalDock: (i) => {
      registered.delete(i);
      removed.push(i);
    },
  },
  coraDockFactory: () => {
    const child = new FakeChild();
    children.push(child);
    return new CoraDock(
      new FakeServer() as unknown as ElgatoServer,
      child as unknown as ElgatoChildServer,
      'dock 3',
    );
  },
  getShuttingDown: () => false,
  port: () => DECK_PORT,
  listenIp: () => '127.0.0.1',
});

async function pairedPage(): Promise<{
  ws: WebSocket;
  texts: Record<string, unknown>[];
  binaries: Uint8Array[];
  waitFor(pred: () => boolean): Promise<void>;
}> {
  const offer = controller.createPairing();
  assert.ok(!('error' in offer));
  const res = await fetch(`http://127.0.0.1:${DECK_PORT}/deck/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shortCode: (offer as { shortCode: string }).shortCode, name: 'Tab' }),
  });
  const { token } = (await res.json()) as { token: string };
  const ws = new WebSocket(`ws://127.0.0.1:${DECK_PORT}/deck/ws`);
  ws.binaryType = 'arraybuffer';
  const page = {
    ws,
    texts: [] as Record<string, unknown>[],
    binaries: [] as Uint8Array[],
    async waitFor(pred: () => boolean) {
      for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 20));
      assert.ok(
        pred(),
        `timed out: ${pred.toString()} texts=${JSON.stringify(page.texts)} bin=${page.binaries.length}`,
      );
    },
  };
  ws.addEventListener('message', (e) => {
    if (typeof e.data === 'string') page.texts.push(JSON.parse(e.data) as Record<string, unknown>);
    else page.binaries.push(new Uint8Array(e.data as ArrayBuffer));
  });
  await new Promise<void>((resolve) => ws.addEventListener('open', () => resolve()));
  ws.send(JSON.stringify({ t: 'hello', v: DECK_PROTOCOL_VERSION, token, clientId: 'c', now: 1 }));
  await page.waitFor(() => page.texts.some((m) => m.t === 'welcome'));
  return page;
}

try {
  console.log('\nvirtual dock');

  await test('disabled by default: nothing registered, nothing listening', async () => {
    await dock3.sync();
    assert.equal(registered.size, 0);
    assert.equal(dock3.isRunning, false);
  });

  await test('enable → dock 3 with its own CORA ports, status chip, listener up', async () => {
    settings.setVirtualDeck({ enabled: true, profile: 'mk2' });
    await dock3.sync();
    assert.equal(controller.lastError, undefined);
    const dock = registered.get(VIRTUAL_DOCK_INDEX)!;
    assert.ok(dock, 'dock registered at the fixed index');
    const status = dock.status();
    assert.equal(status.primaryPort, ELGATO_TCP_PORT + 6);
    assert.equal(status.primaryPort, VIRTUAL_DOCK_PORTS.primary);
    assert.equal(status.virtualClients, 0);
    assert.equal(status.keyCount, 15);
    assert.equal(status.deviceKey, VIRTUAL_DECK_DEVICE_KEY);
    assert.ok(controller.state().listening);
    assert.equal(controller.state().coraPorts.primary, VIRTUAL_DOCK_PORTS.primary);
  });

  await test('a page connecting bumps virtualClients and notifies; keys reach the Elgato child', async () => {
    const before = changed;
    const page = await pairedPage();
    assert.equal(registered.get(VIRTUAL_DOCK_INDEX)!.status().virtualClients, 1);
    assert.ok(changed > before, 'status refresh requested');
    page.ws.send(JSON.stringify({ t: 'key', k: 3, s: 'down', now: 2 }));
    page.ws.send(JSON.stringify({ t: 'key', k: 3, s: 'up', now: 3 }));
    await page.waitFor(() => children[0]!.keys.length >= 2);
    assert.deepEqual(children[0]!.keys, ['3:down', '3:up']);
  });

  await test('Elgato images, slider brightness and pairing state reach the page', async () => {
    const page = await pairedPage();
    const child = children[0]!;
    child.emit('image', { keyIndex: 4, data: Buffer.from([0xff, 0xd8, 0xff]), format: 'jpeg' });
    await page.waitFor(() => page.binaries.length === 1);
    assert.deepEqual([...page.binaries[0]!].slice(0, 4), [1, 4, 0, 0]);
    child.hasClient = true;
    child.emit('clientConnected');
    await page.waitFor(() => page.texts.some((m) => m.t === 'paired' && m.value === true));
    // The Elgato app's own brightness is ignored by default (override on); the WebUI slider path is dock.setBrightness.
    registered.get(VIRTUAL_DOCK_INDEX)!.setBrightness(40);
    await page.waitFor(() => page.texts.some((m) => m.t === 'brightness' && m.level === 40));
  });

  await test('disable → pages get bye disabled, dock removed, port freed', async () => {
    const page = await pairedPage();
    settings.setVirtualDeck({ enabled: false, profile: 'mk2' });
    await dock3.sync();
    await page.waitFor(() => page.texts.some((m) => m.t === 'bye'));
    assert.deepEqual(page.texts.at(-1), { t: 'bye', reason: 'disabled' });
    assert.equal(registered.size, 0);
    assert.ok(removed.includes(VIRTUAL_DOCK_INDEX));
    assert.equal(controller.runtime, null);
    let refused = false;
    try {
      await fetch(`http://127.0.0.1:${DECK_PORT}/deck/`);
    } catch {
      refused = true;
    }
    assert.ok(refused);
  });

  await test('re-enable keeps paired devices (no re-pair) and the same identity', async () => {
    const devices = controller.state().devices.length;
    assert.ok(devices >= 1);
    settings.setVirtualDeck({ enabled: true, profile: 'mk2' });
    await dock3.sync();
    assert.equal(controller.state().devices.length, devices);
    assert.ok(registered.has(VIRTUAL_DOCK_INDEX));
    await dock3.shutdown();
    assert.equal(registered.size, 0);
  });

  await test('a taken deck port: lastError set, nothing left registered', async () => {
    const blocker = tjs.serve({
      port: DECK_PORT,
      listenIp: '127.0.0.1',
      fetch: () => new Response('x'),
    });
    settings.setVirtualDeck({ enabled: true, profile: 'mk2' });
    await dock3.sync();
    assert.ok(controller.lastError?.includes(String(DECK_PORT)), controller.lastError);
    assert.equal(registered.size, 0);
    assert.equal(controller.runtime, null);
    assert.equal(controller.state().listening, false);
    await blocker.close();
    settings.setVirtualDeck({ enabled: false, profile: 'mk2' });
    await dock3.sync();
  });
} finally {
  await dock3.shutdown();
  await ui.stop();
  await settings.close();
}

summaryExit();
