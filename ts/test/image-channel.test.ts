import assert from 'tjs:assert';
import { ImageChannel } from '../src/web/server/image-channel.js';
import type { Broadcaster } from '../src/web/server/broadcaster.js';
import type { WidgetPaint } from '../src/widget-render.js';
import { widgetPreviews } from '../src/web/server/widget-preview.js';
import { EXTRA_KEY_TEXT_SIZES } from '../src/types.js';
import { test, summary } from './helpers/harness.js';

type Sent = {
  event: string;
  data: {
    wireId?: number;
    data?: string;
    clipped?: boolean;
    zone?: boolean;
    full?: true;
    clear?: true;
  };
};

function channel(selected = 0) {
  const sent: Sent[] = [];
  const bus = {
    size: 1,
    broadcast: (event: string, data: Sent['data']) => sent.push({ event, data }),
    sendTo: (_ws: unknown, event: string, data: Sent['data']) => sent.push({ event, data }),
  } as unknown as Broadcaster;
  let dock = selected;
  const ch = new ImageChannel(bus, () => dock);
  const setClients = (n: number) => ((bus as unknown as { size: number }).size = n);
  return { ch, sent, select: (i: number) => (dock = i), setClients };
}

const BMP = new Uint8Array([0x42, 0x4d]);
const PAINT: WidgetPaint = {
  bmp: BMP,
  lines: [{ text: 'Hi', big: true }],
  width: 85,
  height: 85,
  clipped: false,
  zone: false,
};
const extraKeyEvents = (sent: Sent[]) =>
  sent.filter((s) => s.event === 'extraKeyImage').map((s) => s.data);

console.log('\nImageChannel side-key previews');

test('selected dock paint broadcasts base64; a clear broadcasts no data', () => {
  const { ch, sent } = channel();
  ch.notifyDockWidgetPaint(0, 15, PAINT);
  ch.notifyDockWidgetPaint(0, 10, null);
  assert.deepEqual(extraKeyEvents(sent), [{ wireId: 15, data: 'Qk0=' }, { wireId: 10 }]);
});

test('other dock is cached silently and replayed on select', () => {
  const { ch, sent, select } = channel();
  ch.notifyDockWidgetPaint(1, 15, PAINT);
  assert.equal(extraKeyEvents(sent).length, 0);
  select(1);
  ch.replay(1);
  assert.deepEqual(extraKeyEvents(sent), [{ wireId: 15, data: 'Qk0=' }]);
});

test('new WS client gets the selected dock snapshot', () => {
  const { ch, sent } = channel();
  ch.notifyDockWidgetPaint(0, 15, PAINT);
  ch.notifyDockWidgetPaint(0, 10, PAINT);
  ch.notifyDockWidgetPaint(0, 10, null);
  sent.length = 0;
  ch.sendTouchSnapshot({} as ServerWebSocket);
  assert.deepEqual(extraKeyEvents(sent), [{ wireId: 15, data: 'Qk0=' }]);
});

test('reset clears the cache and the live tiles of the selected dock', () => {
  const { ch, sent } = channel();
  ch.notifyDockWidgetPaint(0, 15, PAINT);
  sent.length = 0;
  ch.reset(0);
  assert.deepEqual(extraKeyEvents(sent), [{ wireId: 15 }]);
  sent.length = 0;
  ch.sendTouchSnapshot({} as ServerWebSocket);
  assert.equal(extraKeyEvents(sent).length, 0);
});

test('clipped is sent with the image; a strip zone sends status only', () => {
  const { ch, sent } = channel();
  ch.notifyDockWidgetPaint(0, 15, { ...PAINT, clipped: true });
  ch.notifyDockWidgetPaint(0, 1, { ...PAINT, zone: true, clipped: true });
  assert.deepEqual(extraKeyEvents(sent), [
    { wireId: 15, data: 'Qk0=', clipped: true },
    { wireId: 1, zone: true, clipped: true },
  ]);
  sent.length = 0;
  ch.sendTouchSnapshot({} as ServerWebSocket);
  assert.deepEqual(extraKeyEvents(sent), [
    { wireId: 15, data: 'Qk0=', clipped: true },
    { wireId: 1, zone: true, clipped: true },
  ]);
});

test('selectedWidgetPaint reads the selected dock only', () => {
  const { ch, select } = channel();
  ch.notifyDockWidgetPaint(1, 15, PAINT);
  assert.equal(ch.selectedWidgetPaint(15), undefined);
  select(1);
  assert.equal(ch.selectedWidgetPaint(15), PAINT);
});

console.log('\nImageChannel strip-write mirror');

const SLOT_A = new Uint8Array([1, 2, 3]);
const SLOT_B = new Uint8Array([4, 5, 6]);
const FULL = new Uint8Array([7, 8, 9]);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const stripEvents = (sent: Sent[]) =>
  sent.filter((s) => s.event === 'stripWrite').map((s) => s.data);
function snapshot(ch: ImageChannel, sent: Sent[]): Sent['data'][] {
  sent.length = 0;
  ch.sendTouchSnapshot({} as ServerWebSocket);
  return stripEvents(sent);
}

test('selected dock slot write broadcasts base64', () => {
  const { ch, sent } = channel();
  ch.notifyDockStripWrite(0, 2, SLOT_A, false);
  ch.notifyDockStripWrite(0, 1, FULL, true);
  assert.deepEqual(stripEvents(sent), [
    { wireId: 2, data: b64(SLOT_A) },
    { wireId: 1, data: b64(FULL), full: true },
  ]);
});

test('other dock is cached silently, replayed on select after a clear', () => {
  const { ch, sent, select } = channel();
  ch.notifyDockStripWrite(1, 3, SLOT_A, false);
  assert.equal(stripEvents(sent).length, 0);
  select(1);
  ch.replay(1);
  assert.deepEqual(stripEvents(sent), [{ clear: true }, { wireId: 3, data: b64(SLOT_A) }]);
});

test('a full write drops earlier slots; later slots stack on it', () => {
  const { ch, sent } = channel();
  ch.notifyDockStripWrite(0, 2, SLOT_A, false);
  ch.notifyDockStripWrite(0, 3, SLOT_A, false);
  ch.notifyDockStripWrite(0, 1, FULL, true);
  ch.notifyDockStripWrite(0, 4, SLOT_B, false);
  assert.deepEqual(snapshot(ch, sent), [
    { clear: true },
    { wireId: 1, data: b64(FULL), full: true },
    { wireId: 4, data: b64(SLOT_B) },
  ]);
});

test('two writes to one slot keep the last', () => {
  const { ch, sent } = channel();
  ch.notifyDockStripWrite(0, 2, SLOT_A, false);
  ch.notifyDockStripWrite(0, 2, SLOT_B, false);
  assert.deepEqual(snapshot(ch, sent), [{ clear: true }, { wireId: 2, data: b64(SLOT_B) }]);
});

test('the mirror copies the bytes (a reused driver buffer cannot alter it)', () => {
  const { ch, sent } = channel();
  const bytes = new Uint8Array([1, 2, 3]);
  ch.notifyDockStripWrite(0, 2, bytes, false);
  bytes.fill(0);
  assert.deepEqual(snapshot(ch, sent), [{ clear: true }, { wireId: 2, data: b64(SLOT_A) }]);
});

test('reset of the selected dock broadcasts clear and empties the snapshot', () => {
  const { ch, sent } = channel();
  ch.notifyDockStripWrite(0, 2, SLOT_A, false);
  sent.length = 0;
  ch.reset(0);
  assert.deepEqual(stripEvents(sent), [{ clear: true }]);
  assert.deepEqual(snapshot(ch, sent), [{ clear: true }]);
});

test('pruneDeadDocks drops a dead dock mirror', () => {
  const { ch, sent, select } = channel();
  ch.notifyDockStripWrite(1, 2, SLOT_A, false);
  ch.pruneDeadDocks(new Set([0]));
  select(1);
  assert.deepEqual(snapshot(ch, sent), [{ clear: true }]);
});

test('no WS clients: nothing broadcast, still cached', () => {
  const { ch, sent, setClients } = channel();
  setClients(0);
  ch.notifyDockStripWrite(0, 2, SLOT_A, false);
  ch.replay(0);
  assert.equal(stripEvents(sent).length, 0);
  assert.deepEqual(snapshot(ch, sent), [{ clear: true }, { wireId: 2, data: b64(SLOT_A) }]);
});

console.log('\nwidgetPreviews');

test('one BMP per text size, in picker order, with clipping', () => {
  const previews = widgetPreviews({ ...PAINT, lines: [{ text: 'Hello', big: true }] });
  assert.deepEqual(
    previews.map((p) => p.textSize),
    [...EXTRA_KEY_TEXT_SIZES],
  );
  assert.ok(previews.every((p) => Buffer.from(p.data, 'base64').toString('ascii', 0, 2) === 'BM'));
  const clipped = Object.fromEntries(previews.map((p) => [String(p.textSize), p.clipped]));
  assert.deepEqual(clipped, {
    fit: false,
    '-2': false,
    '-1': false,
    '0': false,
    '1': true,
    '2': true,
  });
});

summary();
