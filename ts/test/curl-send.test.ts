import assert from 'tjs:assert';
import { sendCurl } from '../src/infra/curl-send.js';
import { testAsync as test, summary } from './helpers/harness.js';

const probe = await tjs.listen('tcp', '127.0.0.1', 0);
const { localPort } = await probe.opened;
probe.close();
await probe.closed;
const requests: { method: string; url: string; body: string; userAgent: string | null }[] = [];
let status = 200;
const server = tjs.serve({
  listenIp: '127.0.0.1',
  port: localPort,
  async fetch(req) {
    requests.push({
      method: req.method,
      url: req.url,
      body: await req.text(),
      userAgent: req.headers.get('user-agent'),
    });
    return new Response('', { status });
  },
});
const url = `http://127.0.0.1:${localPort}/s?s=deckbridge-app`;
try {
  await test('curl posts JSON from stdin, without comment in URL', async () => {
    const body = JSON.stringify({ c: 'Feedback & café? #private', a: { rating: '4' } });
    assert.equal(await sendCurl(url, '0.20.0', body), { sent: true });
    assert.equal(requests[0], { method: 'POST', url, body, userAgent: 'DeckBridge/0.20.0' });
  });
  await test('shared beacon helper still sends GET', async () => {
    assert.equal(await sendCurl(url, '0.20.0'), { sent: true });
    assert.equal(requests[1]?.method, 'GET');
    assert.equal(requests[1]?.body, '');
  });
  await test('HTTP errors report rejected', async () => {
    status = 429;
    assert.equal(await sendCurl(url, '0.20.0', '{}'), { sent: false, reason: 'rejected' });
  });
} finally {
  await server.close();
}
await test('offline reports failure', async () => {
  assert.equal(await sendCurl(url, '0.20.0', '{}'), { sent: false, reason: 'offline' });
});
summary();
