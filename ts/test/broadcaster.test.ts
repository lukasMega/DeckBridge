import assert from 'tjs:assert';
import { Broadcaster, WS_MAX_BUFFERED_BYTES } from '../src/web/server/broadcaster.js';
import { test, summary } from './helpers/harness.js';

function fakeWs(buffered: number): ServerWebSocket & { sent: string[]; closed: number } {
  const ws = {
    data: undefined,
    bufferedAmount: buffered,
    sent: [] as string[],
    closed: 0,
    sendText(m: string) {
      this.sent.push(m);
    },
    sendBinary() {},
    close() {
      this.closed++;
    },
  };
  return ws;
}

test('stalled client is closed and dropped; healthy client keeps receiving', () => {
  const b = new Broadcaster();
  const h = b.websocketHandlers(() => {});
  const slow = fakeWs(WS_MAX_BUFFERED_BYTES + 1);
  const ok = fakeWs(0);
  h.open(slow);
  h.open(ok);
  (b as unknown as { send(m: string): void }).send('x');
  assert.equal(slow.sent.length, 0);
  assert.equal(slow.closed, 1);
  assert.equal(ok.sent.length, 1);
  assert.equal(b.size, 1);
});

test('broadcastJson / sendToJson frame a pre-built payload like the typed API', () => {
  const b = new Broadcaster();
  const ws = fakeWs(0);
  b.websocketHandlers(() => {}).open(ws);
  const data = { wireId: 4, data: 'QUJD', clipped: true };
  b.broadcast('extraKeyImage', data);
  b.broadcastJson('extraKeyImage', JSON.stringify(data));
  b.sendTo(ws, 'extraKeyImage', data);
  b.sendToJson(ws, 'extraKeyImage', JSON.stringify(data));
  assert.equal(ws.sent[1], ws.sent[0]);
  assert.equal(ws.sent[3], ws.sent[2]);
  assert.equal(ws.sent[0], ws.sent[2]);
});

test('broadcastJson with no client does nothing', () => {
  const b = new Broadcaster();
  b.broadcastJson('extraKeyImage', '{"wireId":1}');
  assert.equal(b.size, 0);
});

summary();
