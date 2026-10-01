/* eslint-disable sonarjs/no-clear-text-protocols -- fake socket URL, never dialled */
import assert from 'tjs:assert';
import { PressTracker } from '../src/web/client/deck/press-tracker.js';
import { computeDeckLayout, keyOrigin } from '../src/web/client/deck/layout.js';
import {
  TOKEN_KEY,
  clearToken,
  parseHash,
  readToken,
  saveToken,
  tokenFragment,
} from '../src/web/client/deck/token-store.js';
import { decodeDeckFrame } from '../src/web/client/deck/frame-decode.js';
import { DeckSocket, PROTOCOL_VERSION, backoffDelay } from '../src/web/client/deck/deck-socket.js';
import { encodeDeckFrame } from '../src/web/server/virtual-deck/frame-codec.js';
import { DECK_PROTOCOL_VERSION } from '../src/web/server/virtual-deck/deck-constants.js';
import { FakeDeckSocket } from './helpers/fake-deck-socket.js';
import { test, summary } from './helpers/harness.js';

console.log('\ndeck press tracker');

test('one pointer: down then up', () => {
  const t = new PressTracker();
  assert.deepEqual(t.down(1, 3), [{ key: 3, state: 'down' }]);
  assert.deepEqual(t.up(1), [{ key: 3, state: 'up' }]);
  assert.deepEqual(t.up(1), []);
});

test('two pointers on one key: one down, one up after both lift', () => {
  const t = new PressTracker();
  assert.equal(t.down(1, 2).length, 1);
  assert.equal(t.down(2, 2).length, 0);
  assert.equal(t.up(1).length, 0);
  assert.deepEqual(t.up(2), [{ key: 2, state: 'up' }]);
});

test('two pointers on two keys are independent', () => {
  const t = new PressTracker();
  assert.equal(t.down(1, 1).length, 1);
  assert.equal(t.down(2, 4).length, 1);
  assert.deepEqual(t.up(1), [{ key: 1, state: 'up' }]);
  assert.deepEqual(t.up(2), [{ key: 4, state: 'up' }]);
});

test('a duplicate down for the same pointer is ignored; cancel releases', () => {
  const t = new PressTracker();
  t.down(7, 0);
  assert.deepEqual(t.down(7, 5), [], 'a pointer stays bound to its first key');
  assert.deepEqual(t.cancel(7), [{ key: 0, state: 'up' }]);
});

test('releaseAll returns every held key once', () => {
  const t = new PressTracker();
  t.down(1, 9);
  t.down(2, 9);
  t.down(3, 4);
  assert.deepEqual(t.releaseAll(), [
    { key: 4, state: 'up' },
    { key: 9, state: 'up' },
  ]);
  assert.deepEqual(t.up(1), []);
});

console.log('\ndeck layout');

function checkFits(w: number, h: number, ins = { top: 0, right: 0, bottom: 0, left: 0 }): void {
  const g = computeDeckLayout(w, h, 5, 3, ins);
  assert.ok(
    g.left >= ins.left - 0.001 && g.top >= ins.top - 0.001,
    `${w}x${h} origin inside insets`,
  );
  assert.ok(g.left + g.width <= w - ins.right + 0.001, `${w}x${h} right edge`);
  assert.ok(g.top + g.height <= h - ins.bottom + 0.001, `${w}x${h} bottom edge`);
  assert.ok(g.size >= 1);
  const centreX = g.left + g.width / 2;
  assert.ok(Math.abs(centreX - (ins.left + (w - ins.left - ins.right) / 2)) < 0.001, 'centred');
}

test('1024x768, 768x1024, 568x320 fit and centre', () => {
  checkFits(1024, 768);
  checkFits(768, 1024);
  checkFits(568, 320);
});

test('landscape keys are bigger than portrait; keys are square with a 6 % gap', () => {
  const land = computeDeckLayout(1024, 768, 5, 3);
  const port = computeDeckLayout(768, 1024, 5, 3);
  assert.ok(land.size > port.size);
  assert.ok(Math.abs(land.gap - land.size * 0.06) < 0.001);
  assert.equal(land.width, 5 * land.size + 4 * land.gap);
});

test('a notch inset moves and shrinks the grid', () => {
  const ins = { top: 0, right: 44, bottom: 21, left: 44 };
  checkFits(844, 390, ins);
  const plain = computeDeckLayout(844, 390, 5, 3);
  const notched = computeDeckLayout(844, 390, 5, 3, ins);
  assert.ok(notched.size <= plain.size);
});

test('keyOrigin is row-major', () => {
  const g = computeDeckLayout(1000, 600, 5, 3);
  assert.deepEqual(keyOrigin(g, 5, 0), { x: g.left, y: g.top });
  const k7 = keyOrigin(g, 5, 7);
  assert.equal(k7.x, g.left + 2 * (g.size + g.gap));
  assert.equal(k7.y, g.top + (g.size + g.gap));
});

console.log('\ndeck token store');

test('parseHash reads pair and t, ignores the rest', () => {
  assert.deepEqual(parseHash('#pair=ABC234'), { pair: 'ABC234' });
  assert.deepEqual(parseHash('#t=dbp_abc-_9'), { token: 'dbp_abc-_9' });
  assert.deepEqual(parseHash('#x=1&t=a%2Bb&pair='), { token: 'a+b' });
  assert.deepEqual(parseHash(''), {});
  assert.deepEqual(parseHash('#t=%E0%A4%A'), {});
});

test('tokenFragment round-trips through parseHash', () => {
  const token = 'dbp_a-b_c+/=';
  assert.equal(parseHash(tokenFragment(token)).token, token);
});

test('storage helpers survive a throwing storage', () => {
  const mem = new Map<string, string>();
  const ok = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  };
  saveToken('tok', ok);
  assert.equal(mem.get(TOKEN_KEY), 'tok');
  assert.equal(readToken(ok), 'tok');
  clearToken(ok);
  assert.equal(readToken(ok), null);
  const boom = {
    getItem: (): string | null => {
      throw new Error('denied');
    },
    setItem: (): void => {
      throw new Error('denied');
    },
    removeItem: (): void => {
      throw new Error('denied');
    },
  };
  assert.equal(readToken(boom), null);
  saveToken('x', boom);
  clearToken(boom);
});

console.log('\ndeck frame decode');

test('server encoder and client decoder agree (keys 0/14/255, jpeg and bmp)', () => {
  for (const key of [0, 14, 255]) {
    for (const format of ['jpeg', 'bmp'] as const) {
      const bytes = new Uint8Array([1, 2, 3, key]);
      const frame = decodeDeckFrame(encodeDeckFrame(key, bytes, format).buffer);
      if (!frame) throw new Error('decode failed');
      assert.equal(frame.key, key);
      assert.equal(frame.format, format);
      assert.deepEqual([...frame.bytes], [...bytes]);
    }
  }
});

test('decode rejects a short buffer, an unknown type and an unknown format', () => {
  assert.equal(decodeDeckFrame(new ArrayBuffer(3)), null);
  assert.equal(decodeDeckFrame(new Uint8Array([2, 0, 0, 0, 1]).buffer), null);
  assert.equal(decodeDeckFrame(new Uint8Array([1, 0, 7, 0, 1]).buffer), null);
});

test('client and server protocol versions match', () => {
  assert.equal(PROTOCOL_VERSION, DECK_PROTOCOL_VERSION);
});

console.log('\ndeck socket');

const WELCOME = {
  t: 'welcome',
  v: 1,
  layout: { profile: 'mk2', columns: 5, rows: 3, keyCount: 15, rotate: 180 },
  brightness: 70,
  paired: true,
  deviceName: 'iPad',
};

function makeSocket(): {
  ds: DeckSocket;
  socks: FakeDeckSocket[];
  log: string[];
  frames: number[];
} {
  const socks: FakeDeckSocket[] = [];
  const log: string[] = [];
  const frames: number[] = [];
  const ds = new DeckSocket({
    url: 'ws://x/deck/ws',
    token: 'tok',
    clientId: 'cid',
    name: 'iPad',
    createSocket: () => {
      const s = new FakeDeckSocket();
      socks.push(s);
      return s;
    },
    now: () => 1234,
    onState: (s) => log.push(`state:${s}`),
    onReset: () => log.push('reset'),
    onWelcome: () => log.push('welcome'),
    onFrame: (f) => frames.push(f.key),
    onClear: (k) => log.push(`clear:${k}`),
    onBrightness: (l) => log.push(`brightness:${l}`),
    onPaired: (v) => log.push(`paired:${v}`),
    onBye: (r) => log.push(`bye:${r}`),
  });
  return { ds, socks, log, frames };
}

test('open → reset then hello; keys only flow after welcome', () => {
  const { ds, socks, log } = makeSocket();
  ds.connect();
  const s = socks[0]!;
  assert.equal(ds.sendKey(1, 'down'), false, 'not open yet');
  s.open();
  assert.deepEqual(log.slice(0, 2), ['state:connecting', 'reset']);
  assert.deepEqual(s.sent[0], {
    t: 'hello',
    v: 1,
    token: 'tok',
    clientId: 'cid',
    now: 1234,
    name: 'iPad',
  });
  assert.equal(ds.sendKey(1, 'down'), false, 'open but not welcomed: dropped, never queued');
  s.text(WELCOME);
  assert.equal(ds.sendKey(1, 'down'), true);
  assert.deepEqual(s.sent.at(-1), { t: 'key', k: 1, s: 'down', now: 1234 });
  ds.stop();
});

test('binary frames are acked cumulatively before decode and reach onFrame', () => {
  const { ds, socks, frames } = makeSocket();
  ds.connect();
  const s = socks[0]!;
  s.open();
  s.text(WELCOME);
  s.binary(encodeDeckFrame(3, new Uint8Array([1]), 'jpeg').buffer);
  s.binary(encodeDeckFrame(4, new Uint8Array([1]), 'jpeg').buffer);
  assert.deepEqual(frames, [3, 4]);
  assert.deepEqual(
    s.sent.filter((m) => m.t === 'ack').map((m) => m.n),
    [1, 2],
  );
  ds.stop();
});

test('clear, brightness and paired are forwarded', () => {
  const { ds, socks, log } = makeSocket();
  ds.connect();
  const s = socks[0]!;
  s.open();
  s.text(WELCOME);
  s.text({ t: 'clear', k: 5 });
  s.text({ t: 'brightness', level: 20 });
  s.text({ t: 'paired', value: false });
  assert.deepEqual(log.slice(-3), ['clear:5', 'brightness:20', 'paired:false']);
  ds.stop();
});

test('bye unauthorized is terminal: no reconnect after close', () => {
  const { ds, socks, log } = makeSocket();
  ds.connect();
  const s = socks[0]!;
  s.open();
  s.text({ t: 'bye', reason: 'unauthorized' });
  s.drop();
  assert.ok(log.includes('bye:unauthorized'));
  assert.equal(log.at(-1), 'state:stopped');
  assert.equal(socks.length, 1);
});

test('suspend sends releaseAll, closes, and drops input until resume', () => {
  const { ds, socks } = makeSocket();
  ds.connect();
  const s = socks[0]!;
  s.open();
  s.text(WELCOME);
  ds.suspend();
  assert.deepEqual(s.sent.at(-1), { t: 'releaseAll', now: 1234 });
  assert.equal(s.closed, true);
  assert.equal(ds.sendKey(2, 'down'), false);
  ds.resume();
  assert.equal(socks.length, 2, 'resume dials a fresh socket');
  ds.stop();
});

test('backoff doubles from 500 ms to a 5 s cap with ±20 % jitter', () => {
  assert.equal(backoffDelay(0, 0.5), 500);
  assert.equal(backoffDelay(1, 0.5), 1000);
  assert.equal(backoffDelay(3, 0.5), 4000);
  assert.equal(backoffDelay(9, 0.5), 5000);
  assert.equal(backoffDelay(0, 0), 400);
  assert.equal(backoffDelay(0, 1), 600);
});

summary();
