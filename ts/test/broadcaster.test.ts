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

summary();
