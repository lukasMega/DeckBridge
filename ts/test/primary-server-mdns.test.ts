import assert from 'tjs:assert';
import { ElgatoServer } from '../src/cora/primary-server.js';
import { modelToChildGeometry } from '../src/devices/registry.js';
import { MK2_MODEL } from '../src/devices/elgato/mk2.js';
import { testAsync as test, summaryExit } from './helpers/harness.js';

console.log('\nElgatoServer.setMdnsEnabled');

interface FakeAdvertiser {
  starts: number;
  stops: number;
  start(): Promise<void>;
  stop(): void;
  updateIdentity(): void;
}

/** Counts spawned advertisers; the real one would run dns-sd / avahi. */
function stubAdvertiser(server: ElgatoServer): FakeAdvertiser[] {
  const spawned: FakeAdvertiser[] = [];
  (server as unknown as { spawnAdvertiser: () => FakeAdvertiser }).spawnAdvertiser =
    function spawn(): FakeAdvertiser {
      const a: FakeAdvertiser = {
        starts: 0,
        stops: 0,
        start: () => {
          a.starts++;
          return Promise.resolve();
        },
        stop: () => {
          a.stops++;
        },
        updateIdentity: () => {},
      };
      spawned.push(a);
      return a;
    };
  return spawned;
}

function nth(list: FakeAdvertiser[], i: number): FakeAdvertiser {
  const a = list[i];
  if (!a) throw new Error(`no advertiser #${i}`);
  return a;
}

const geo = modelToChildGeometry(MK2_MODEL);

await test('off stops the advertiser and on spawns a new one', async () => {
  const s = new ElgatoServer(geo, 15461, false, { childPort: 15462 });
  const spawned = stubAdvertiser(s);
  await s.start();
  try {
    assert.equal(spawned.length, 1);
    s.setMdnsEnabled(false);
    assert.equal(nth(spawned, 0).stops, 1);
    s.setMdnsEnabled(false); // idempotent
    assert.equal(nth(spawned, 0).stops, 1);
    s.setMdnsEnabled(true);
    assert.equal(spawned.length, 2);
    assert.equal(nth(spawned, 1).starts, 1);
    s.setMdnsEnabled(true); // already advertising
    assert.equal(spawned.length, 2);
  } finally {
    await s.stop();
  }
  assert.equal(nth(spawned, 1).stops, 1, 'stop() still stops the live advertiser');
});

await test('start() respects an off set before it', async () => {
  const s = new ElgatoServer(geo, 15463, false, { childPort: 15464 });
  const spawned = stubAdvertiser(s);
  s.setMdnsEnabled(false);
  s.setMdnsEnabled(true);
  assert.equal(spawned.length, 0, 'on before start() spawns nothing');
  s.setMdnsEnabled(false);
  await s.start();
  try {
    assert.equal(spawned.length, 0);
    s.setMdnsEnabled(true);
    assert.equal(spawned.length, 1);
  } finally {
    await s.stop();
  }
});

await test('on never overrides the constructor skipMdns', async () => {
  const s = new ElgatoServer(geo, 15465, true, { childPort: 15466 });
  const spawned = stubAdvertiser(s);
  await s.start();
  try {
    s.setMdnsEnabled(false);
    s.setMdnsEnabled(true);
    assert.equal(spawned.length, 0);
  } finally {
    await s.stop();
  }
});

summaryExit();
