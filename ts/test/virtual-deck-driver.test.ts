import assert from 'tjs:assert';
import { VirtualDeckDriver } from '../src/main/virtual-deck/virtual-deck-driver.js';
import { hashJpeg } from '../src/shared/image-hash.js';
import { test, testAsync, summary } from './helpers/harness.js';

function rig(): {
  driver: VirtualDeckDriver;
  calls: string[];
  events: string[];
} {
  const driver = new VirtualDeckDriver('mk2');
  const calls: string[] = [];
  const events: string[] = [];
  driver.setSink({
    frame: (k, d, f) => calls.push(`frame ${k} ${d.length} ${f}`),
    clear: (k) => calls.push(`clear ${k}`),
    brightness: (l) => calls.push(`brightness ${l}`),
  });
  driver.on('key', (e: { keyIndex: number; state: string }) =>
    events.push(`${e.keyIndex}:${e.state}`),
  );
  driver.on('disconnect', () => events.push('disconnect'));
  return { driver, calls, events };
}

console.log('\nvirtual deck driver');

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

await testAsync('CORA images emit the raw frame hash off the ACK path, sink or not', async () => {
  const driver = new VirtualDeckDriver('mk2');
  const hashes: unknown[][] = [];
  driver.on('frameHash', (...args: unknown[]) => hashes.push(args));
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  driver.renderCoraImage(3, bytes, 'jpeg');
  assert.deepEqual(hashes, [], 'nothing is hashed inside renderCoraImage');
  await tick();
  assert.deepEqual(hashes, [[3, hashJpeg(bytes)]]);
});

await testAsync('a burst hashes only the latest frame per key, one key per tick', async () => {
  const driver = new VirtualDeckDriver('mk2');
  const hashes: [number, string][] = [];
  driver.on('frameHash', (k: number, h: string) => hashes.push([k, h]));
  const first = new Uint8Array([1, 1, 1, 1]);
  const second = new Uint8Array([2, 2, 2, 2]);
  driver.renderCoraImage(0, first, 'jpeg');
  driver.renderCoraImage(0, second, 'jpeg');
  driver.renderCoraImage(1, first, 'jpeg');
  await tick();
  await tick();
  assert.deepEqual(hashes, [
    [0, hashJpeg(second)],
    [1, hashJpeg(first)],
  ]);
});

await testAsync('clearKey and close drop pending hashes', async () => {
  const driver = new VirtualDeckDriver('mk2');
  const hashes: unknown[] = [];
  driver.on('frameHash', (...args: unknown[]) => hashes.push(args));
  driver.renderCoraImage(0, new Uint8Array(8), 'jpeg');
  driver.clearKey(0);
  driver.renderCoraImage(1, new Uint8Array(8), 'jpeg');
  await driver.close();
  await tick();
  assert.deepEqual(hashes, []);
});

test('layout is the MK.2 grid with the 180° display rotation', () => {
  const { driver } = rig();
  assert.deepEqual(driver.layout(), {
    profile: 'mk2',
    columns: 5,
    rows: 3,
    keyCount: 15,
    rotate: 180,
  });
  assert.equal(driver.model.id, 'browser-deck-mk2');
});

test('renderCoraImage stores the frame and forwards it; snapshot has the latest per key', () => {
  const { driver, calls } = rig();
  driver.renderCoraImage(3, new Uint8Array([1, 2]), 'jpeg');
  driver.renderCoraImage(3, new Uint8Array([9]), 'jpeg');
  assert.deepEqual(calls, ['frame 3 2 jpeg', 'frame 3 1 jpeg']);
  assert.equal(driver.snapshot().size, 1);
  assert.deepEqual([...driver.snapshot().get(3)!.data], [9]);
});

test('clearKey and setBrightness are forwarded and remembered', () => {
  const { driver, calls } = rig();
  driver.renderCoraImage(1, new Uint8Array([1]), 'jpeg');
  driver.clearKey(1);
  driver.setBrightness(40);
  assert.deepEqual(calls.slice(1), ['clear 1', 'brightness 40']);
  assert.equal(driver.snapshot().size, 0);
  assert.equal(driver.brightnessLevel(), 40);
});

await testAsync('input emits key with an MK.2 index and never disconnects', async () => {
  const { driver, events } = rig();
  driver.input(14, 'down');
  driver.input(14, 'up');
  await driver.close();
  assert.deepEqual(events, ['14:down', '14:up']);
});

await testAsync('no-op methods do not throw and nothing reaches a detached sink', async () => {
  const { driver, calls } = rig();
  driver.sendSplashImage(0, new Uint8Array(0), driver.model.image);
  driver.renderTouchImage();
  driver.setTouchStripMask();
  driver.restoreTouchSegments();
  driver.setTouchStripOptions();
  driver.applyOverrides(undefined, driver.model);
  driver.setLogLevel();
  await driver.close();
  driver.renderCoraImage(0, new Uint8Array(1), 'jpeg');
  assert.deepEqual(calls, []);
});

summary();
