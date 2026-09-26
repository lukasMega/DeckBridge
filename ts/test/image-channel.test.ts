import assert from 'tjs:assert';
import { ImageChannel } from '../src/web/server/image-channel.js';
import type { Broadcaster } from '../src/web/server/broadcaster.js';
import type { WidgetPaint } from '../src/widget-render.js';
import { widgetPreviews } from '../src/web/server/widget-preview.js';
import { EXTRA_KEY_TEXT_SIZES } from '../src/types.js';
import { test, summary } from './helpers/harness.js';

type Sent = {
  event: string;
  data: { wireId?: number; data?: string; clipped?: boolean; zone?: boolean };
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
  return { ch, sent, select: (i: number) => (dock = i) };
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
