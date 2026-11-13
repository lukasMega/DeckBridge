import assert from 'tjs:assert';
import { WebSocket, fetch } from '../src/demo/browser-shims.js';
import { backend } from '../src/demo/install.js';
import { testAsync, summary } from './helpers/harness.js';

await testAsync('injected fetch answers from the demo backend', async () => {
  const r = await fetch('/api/state');
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { driverConnected: boolean }).driverConnected, false);
  assert.equal((await fetch('/api/survey')).status, 404);
});

await testAsync('injected WebSocket receives backend broadcasts', async () => {
  const ws = new WebSocket('wss://demo.invalid/api/ws');
  const got: string[] = [];
  ws.addEventListener('message', (e) => got.push(e.data));
  await new Promise<void>((resolve) => ws.addEventListener('open', () => resolve()));
  backend.broadcast('brightness', { level: 10 });
  ws.close();
  backend.broadcast('brightness', { level: 20 });
  assert.deepEqual(got, [JSON.stringify({ event: 'brightness', data: { level: 10 } })]);
});

summary();
