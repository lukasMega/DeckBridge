import assert from 'tjs:assert';
import { EventEmitter } from 'node:events';
import { PairingWatchdog } from '../src/cora-pairing-watchdog.js';
import { setLogLevel } from '../src/logger.js';
import { testAsync, summary } from './helpers/harness.js';

setLogLevel('silent');

class FakeEnd extends EventEmitter {
  hasClient = false;
  drops = 0;
  connect(): void {
    this.hasClient = true;
    this.emit('clientConnected', '127.0.0.1');
  }
  disconnect(): void {
    this.hasClient = false;
    this.emit('clientDisconnected');
  }
  dropClient(): void {
    this.drops++;
    this.disconnect();
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const OPTS = { earlyDropMs: 50, recheckMs: 20, maxRetries: 2 };

function setup(): { primary: FakeEnd; child: FakeEnd; dog: PairingWatchdog } {
  const primary = new FakeEnd();
  const child = new FakeEnd();
  const dog = new PairingWatchdog(primary, child, 'dock 0', OPTS);
  primary.connect();
  return { primary, child, dog };
}

console.log('\nPairingWatchdog');

await testAsync('aborted child session that is not re-opened drops the primary', async () => {
  const { primary, child } = setup();
  child.connect();
  child.disconnect();
  await sleep(40);
  assert.equal(primary.drops, 1);
});

await testAsync(
  'probe session re-opened at once (normal pairing) leaves the primary alone',
  async () => {
    const { primary, child } = setup();
    child.connect();
    child.disconnect();
    child.connect();
    await sleep(40);
    assert.equal(primary.drops, 0);
  },
);

await testAsync('long child session ending is a normal unpair, not an abort', async () => {
  const { primary, child } = setup();
  child.connect();
  await sleep(70);
  child.disconnect();
  await sleep(40);
  assert.equal(primary.drops, 0);
});

await testAsync('no primary client → nothing to restart', async () => {
  const { primary, child } = setup();
  child.connect();
  primary.disconnect();
  child.disconnect();
  await sleep(40);
  assert.equal(primary.drops, 0);
});

await testAsync('retries stop at maxRetries', async () => {
  const { primary, child } = setup();
  for (let i = 0; i < 4; i++) {
    primary.connect();
    child.connect();
    child.disconnect();
    await sleep(40);
  }
  assert.equal(primary.drops, 2);
});

await testAsync('a stable session resets the retry budget', async () => {
  const { primary, child } = setup();
  for (let i = 0; i < 2; i++) {
    primary.connect();
    child.connect();
    child.disconnect();
    await sleep(40);
  }
  primary.connect();
  child.connect();
  await sleep(70);
  child.disconnect();
  child.connect();
  child.disconnect();
  await sleep(40);
  assert.equal(primary.drops, 3);
});

summary();
