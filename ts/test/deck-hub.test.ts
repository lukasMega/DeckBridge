/* eslint-disable sonarjs/no-hardcoded-ip -- fixture addresses, nothing is contacted */
import assert from 'tjs:assert';
import { DeckHub, type DeckSource } from '../src/web/server/virtual-deck/deck-hub.js';
import type { DeckSocket } from '../src/web/server/virtual-deck/deck-session.js';
import {
  DECK_LIVENESS_TIMEOUT_MS,
  DECK_MAX_CLIENTS,
  DECK_MAX_IN_FLIGHT,
  DECK_PROTOCOL_VERSION,
} from '../src/web/server/virtual-deck/deck-constants.js';
import { testAsync as test, summary } from './helpers/harness.js';

class FakeSocket implements DeckSocket {
  texts: Record<string, unknown>[] = [];
  binaries: Uint8Array[] = [];
  closed = false;
  sendText(d: string): void {
    this.texts.push(JSON.parse(d) as Record<string, unknown>);
  }
  sendBinary(d: Uint8Array): void {
    this.binaries.push(d);
  }
  close(): void {
    this.closed = true;
  }
  last(): Record<string, unknown> | undefined {
    return this.texts.at(-1);
  }
}

interface Setup {
  hub: DeckHub;
  inputs: string[];
  clock: { t: number };
  failed: string[];
  snapshot: Map<number, { data: Uint8Array; format: 'jpeg' | 'bmp' }>;
}

function setup(): Setup {
  const clock = { t: 10_000 };
  const inputs: string[] = [];
  const failed: string[] = [];
  const snapshot = new Map<number, { data: Uint8Array; format: 'jpeg' | 'bmp' }>();
  const source: DeckSource = {
    layout: () => ({ profile: 'mk2', columns: 5, rows: 3, keyCount: 15, rotate: 180 }),
    snapshot: () => snapshot,
    brightness: () => 80,
    elgatoPaired: () => true,
    input: (k, s) => inputs.push(`${k}:${s}`),
  };
  const tokens: Record<string, { id: string; name: string }> = {
    good: { id: 'tok1', name: 'iPad' },
    good2: { id: 'tok2', name: 'Phone' },
  };
  const hub = new DeckHub({
    source,
    auth: { verify: (t) => Promise.resolve(tokens[t] ?? null), noteSeen: () => {} },
    limits: { checkFailedAuth: () => 0, noteFailedAuth: (r) => failed.push(r) },
    now: () => clock.t,
  });
  return { hub, inputs, clock, failed, snapshot };
}

const send = (hub: DeckHub, ws: DeckSocket, msg: unknown): void =>
  hub.message(ws, JSON.stringify(msg));
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function connect(s: Setup, token = 'good', clientId = 'c1'): Promise<FakeSocket> {
  const ws = new FakeSocket();
  s.hub.open(ws, '10.0.0.5');
  send(s.hub, ws, { t: 'hello', v: DECK_PROTOCOL_VERSION, token, clientId, now: s.clock.t });
  await tick();
  return ws;
}

console.log('\ndeck hub');

await test('no hello within 3 s → bye timeout and close', () => {
  const s = setup();
  const ws = new FakeSocket();
  s.hub.open(ws, 'a');
  s.clock.t += 2900;
  s.hub.tick();
  assert.equal(ws.closed, false);
  s.clock.t += 200;
  s.hub.tick();
  assert.deepEqual(ws.last(), { t: 'bye', reason: 'timeout' });
  assert.equal(ws.closed, true);
});

await test('a message before hello → bye protocol', () => {
  const s = setup();
  const ws = new FakeSocket();
  s.hub.open(ws, 'a');
  send(s.hub, ws, { t: 'ping', now: 1 });
  assert.deepEqual(ws.last(), { t: 'bye', reason: 'protocol' });
});

await test('bad token → bye unauthorized and a failed-auth note', async () => {
  const s = setup();
  const ws = await connect(s, 'nope');
  assert.deepEqual(ws.last(), { t: 'bye', reason: 'unauthorized' });
  assert.deepEqual(s.failed, ['10.0.0.5']);
});

await test('wrong protocol version → bye upgrade', async () => {
  const s = setup();
  const ws = new FakeSocket();
  s.hub.open(ws, 'a');
  send(s.hub, ws, { t: 'hello', v: 99, token: 'good', clientId: 'c', now: 0 });
  await tick();
  assert.deepEqual(ws.last(), { t: 'bye', reason: 'upgrade' });
});

await test('good token → welcome, then the snapshot frames in key order', async () => {
  const s = setup();
  s.snapshot.set(5, { data: new Uint8Array([5]), format: 'jpeg' });
  s.snapshot.set(2, { data: new Uint8Array([2]), format: 'jpeg' });
  const ws = await connect(s);
  const welcome = ws.texts[0] as Record<string, unknown>;
  assert.equal(welcome.t, 'welcome');
  assert.equal(welcome.paired, true);
  assert.equal(welcome.brightness, 80);
  assert.equal(welcome.deviceName, 'iPad');
  assert.deepEqual(
    ws.binaries.map((b) => b[1]),
    [2, 5],
  );
  assert.equal(s.hub.clients().length, 1);
});

await test('key down/up reach the source once; out-of-range key → bye protocol', async () => {
  const s = setup();
  const ws = await connect(s);
  send(s.hub, ws, { t: 'key', k: 3, s: 'down', now: s.clock.t });
  send(s.hub, ws, { t: 'key', k: 3, s: 'up', now: s.clock.t });
  assert.deepEqual(s.inputs, ['3:down', '3:up']);
  send(s.hub, ws, { t: 'key', k: 15, s: 'down', now: s.clock.t });
  assert.deepEqual(ws.last(), { t: 'bye', reason: 'protocol' });
});

await test('held key is released after 3.5 s of silence and the session closes', async () => {
  const s = setup();
  const ws = await connect(s);
  send(s.hub, ws, { t: 'key', k: 1, s: 'down', now: s.clock.t });
  s.clock.t += DECK_LIVENESS_TIMEOUT_MS - 100;
  s.hub.tick();
  assert.equal(ws.closed, false);
  s.clock.t += 200;
  s.hub.tick();
  assert.deepEqual(s.inputs, ['1:down', '1:up']);
  assert.equal(ws.closed, true);
  assert.equal(s.hub.clients().length, 0);
});

await test('held key is released on socket close and on releaseAll', async () => {
  const s = setup();
  const a = await connect(s);
  send(s.hub, a, { t: 'key', k: 1, s: 'down', now: s.clock.t });
  s.hub.close(a);
  assert.deepEqual(s.inputs, ['1:down', '1:up']);
  const b = await connect(s, 'good', 'c2');
  send(s.hub, b, { t: 'key', k: 2, s: 'down', now: s.clock.t });
  send(s.hub, b, { t: 'releaseAll', now: s.clock.t });
  assert.deepEqual(s.inputs.slice(2), ['2:down', '2:up']);
  send(s.hub, b, { t: 'key', k: 2, s: 'up', now: s.clock.t });
  assert.equal(s.inputs.length, 4, 'a later up for a released key is ignored');
});

await test('never replay: a down more than 1 s late is dropped and its up ignored', async () => {
  const s = setup();
  const ws = await connect(s);
  send(s.hub, ws, { t: 'ping', now: s.clock.t });
  s.clock.t += 5000;
  send(s.hub, ws, { t: 'key', k: 4, s: 'down', now: s.clock.t - 4210 });
  send(s.hub, ws, { t: 'key', k: 4, s: 'up', now: s.clock.t - 4100 });
  assert.deepEqual(s.inputs, []);
});

await test('two pages mirror frames; one holding a key keeps it down', async () => {
  const s = setup();
  const a = await connect(s, 'good', 'a');
  const b = await connect(s, 'good2', 'b');
  s.hub.frame(7, new Uint8Array([7]), 'jpeg');
  assert.equal(a.binaries.length, 1);
  assert.equal(b.binaries.length, 1);
  send(s.hub, a, { t: 'key', k: 3, s: 'down', now: s.clock.t });
  send(s.hub, b, { t: 'key', k: 3, s: 'down', now: s.clock.t });
  send(s.hub, a, { t: 'key', k: 3, s: 'up', now: s.clock.t });
  assert.deepEqual(s.inputs, ['3:down']);
  send(s.hub, b, { t: 'key', k: 3, s: 'up', now: s.clock.t });
  assert.deepEqual(s.inputs, ['3:down', '3:up']);
});

await test('the 5th live page gets bye full', async () => {
  const s = setup();
  for (let i = 0; i < DECK_MAX_CLIENTS; i++) await connect(s, 'good', `c${i}`);
  const extra = await connect(s, 'good', 'extra');
  assert.deepEqual(extra.last(), { t: 'bye', reason: 'full' });
});

await test('more than 60 messages in a second → bye protocol', async () => {
  const s = setup();
  const ws = await connect(s);
  for (let i = 0; i < 70; i++) send(s.hub, ws, { t: 'ping', now: s.clock.t });
  assert.deepEqual(ws.last(), { t: 'bye', reason: 'protocol' });
});

await test('ack opens the window; clear and brightness/paired reach live pages', async () => {
  const s = setup();
  const ws = await connect(s);
  for (let k = 0; k < DECK_MAX_IN_FLIGHT + 2; k++) s.hub.frame(k, new Uint8Array([k]), 'jpeg');
  assert.equal(ws.binaries.length, DECK_MAX_IN_FLIGHT);
  send(s.hub, ws, { t: 'ack', n: 2 });
  assert.equal(ws.binaries.length, DECK_MAX_IN_FLIGHT + 2);
  s.hub.brightness(40);
  s.hub.paired(false);
  s.hub.clear(14);
  assert.deepEqual(ws.texts.slice(-3), [
    { t: 'brightness', level: 40 },
    { t: 'paired', value: false },
    { t: 'clear', k: 14 },
  ]);
});

await test('kick closes only that token and releases its keys; closeAll says why', async () => {
  const s = setup();
  const a = await connect(s, 'good', 'a');
  const b = await connect(s, 'good2', 'b');
  send(s.hub, a, { t: 'key', k: 6, s: 'down', now: s.clock.t });
  s.hub.kick('tok1', 'revoked');
  assert.deepEqual(a.last(), { t: 'bye', reason: 'revoked' });
  assert.equal(b.closed, false);
  assert.deepEqual(s.inputs, ['6:down', '6:up']);
  s.hub.closeAll('disabled');
  assert.deepEqual(b.last(), { t: 'bye', reason: 'disabled' });
});

summary();
