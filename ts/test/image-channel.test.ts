import assert from 'tjs:assert';
import { ImageChannel } from '../src/web/server/image-channel.js';
import type { Broadcaster } from '../src/web/server/broadcaster.js';
import { test, summary } from './helpers/harness.js';

type Sent = { event: string; data: { wireId?: number; data?: string } };

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
const extraKeyEvents = (sent: Sent[]) =>
  sent.filter((s) => s.event === 'extraKeyImage').map((s) => s.data);

console.log('\nImageChannel side-key previews');

test('selected dock paint broadcasts base64; a clear broadcasts no data', () => {
  const { ch, sent } = channel();
  ch.notifyDockExtraKeyImage(0, 15, BMP);
  ch.notifyDockExtraKeyImage(0, 10, null);
  assert.deepEqual(extraKeyEvents(sent), [{ wireId: 15, data: 'Qk0=' }, { wireId: 10 }]);
});

test('other dock is cached silently and replayed on select', () => {
  const { ch, sent, select } = channel();
  ch.notifyDockExtraKeyImage(1, 15, BMP);
  assert.equal(extraKeyEvents(sent).length, 0);
  select(1);
  ch.replay(1);
  assert.deepEqual(extraKeyEvents(sent), [{ wireId: 15, data: 'Qk0=' }]);
});

test('new WS client gets the selected dock snapshot', () => {
  const { ch, sent } = channel();
  ch.notifyDockExtraKeyImage(0, 15, BMP);
  ch.notifyDockExtraKeyImage(0, 10, BMP);
  ch.notifyDockExtraKeyImage(0, 10, null);
  sent.length = 0;
  ch.sendTouchSnapshot({} as ServerWebSocket);
  assert.deepEqual(extraKeyEvents(sent), [{ wireId: 15, data: 'Qk0=' }]);
});

test('reset clears the cache and the live tiles of the selected dock', () => {
  const { ch, sent } = channel();
  ch.notifyDockExtraKeyImage(0, 15, BMP);
  sent.length = 0;
  ch.reset(0);
  assert.deepEqual(extraKeyEvents(sent), [{ wireId: 15 }]);
  sent.length = 0;
  ch.sendTouchSnapshot({} as ServerWebSocket);
  assert.equal(extraKeyEvents(sent).length, 0);
});

summary();
