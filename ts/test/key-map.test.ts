import assert from 'tjs:assert';
import {
  mk2IndexToDeviceImgId,
  deviceInputToMk2Index,
  deviceInputToExtraKey,
} from '../src/key-map.js';
import { MIRABOX_293_MODEL } from '../src/devices/mirabox/mirabox-293.js';
import { MIRABOX_K1PRO_MODEL } from '../src/devices/mirabox/mirabox-k1pro.js';
import { testAsync as test, summaryExit } from './helpers/harness.js';

const coraToWireImage = MIRABOX_293_MODEL.keyMap.coraToWireImage!;

console.log('\nkey-map: index mapping');

await test('mirabox-293 coraToWireImage has 15 entries, all unique, values 1–15', () => {
  assert.equal(coraToWireImage.length, 15);
  const vals = coraToWireImage.toSorted((a, b) => a - b);
  assert.deepEqual(vals, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
});

await test('mk2IndexToDeviceImgId(0, mirabox-293) === 11 (top-left)', () => {
  assert.equal(mk2IndexToDeviceImgId(0, MIRABOX_293_MODEL), 11);
});

await test('mk2IndexToDeviceImgId(4, mirabox-293) === 15 (top-right)', () => {
  assert.equal(mk2IndexToDeviceImgId(4, MIRABOX_293_MODEL), 15);
});

await test('mk2IndexToDeviceImgId(14, mirabox-293) === 5 (bottom-right)', () => {
  assert.equal(mk2IndexToDeviceImgId(14, MIRABOX_293_MODEL), 5);
});

await test('middle row (indices 5–9) maps to i+1', () => {
  for (let i = 5; i <= 9; i++) {
    assert.equal(mk2IndexToDeviceImgId(i, MIRABOX_293_MODEL), i + 1);
  }
});

await test('mk2IndexToDeviceImgId(15, mirabox-293) === -1 (just past 15-entry array)', () => {
  assert.equal(mk2IndexToDeviceImgId(15, MIRABOX_293_MODEL), -1);
});

await test('mk2IndexToDeviceImgId(99, mirabox-293) === -1 (far OOB)', () => {
  assert.equal(mk2IndexToDeviceImgId(99, MIRABOX_293_MODEL), -1);
});

await test('deviceInputToExtraKey: pairs extraKeyInputs with extraKeys by position', () => {
  const model = {
    ...MIRABOX_293_MODEL,
    keyMap: { ...MIRABOX_293_MODEL.keyMap, extraKeys: [15, 10], extraKeyInputs: [5, 10] },
  };
  assert.equal(deviceInputToExtraKey(5, model), 15);
  assert.equal(deviceInputToExtraKey(10, model), 10);
  assert.equal(deviceInputToExtraKey(1, model), -1, 'a grid key');
  assert.equal(deviceInputToExtraKey(5, MIRABOX_293_MODEL), -1, 'no extraKeyInputs');
});

await test('deviceInputToMk2Index(0x01, mirabox-293) === 0', () => {
  assert.equal(deviceInputToMk2Index(0x01, MIRABOX_293_MODEL), 0);
});

await test('deviceInputToMk2Index(0x0F, mirabox-293) === 14', () => {
  assert.equal(deviceInputToMk2Index(0x0f, MIRABOX_293_MODEL), 14);
});

await test('round-trip: all codes 1–15 map to indices 0–14', () => {
  for (let code = 1; code <= 15; code++) {
    const idx = deviceInputToMk2Index(code, MIRABOX_293_MODEL);
    assert.ok(idx >= 0 && idx <= 14);
  }
});

// K1 Pro mapping tests

console.log('\nkey-map: mirabox-k1pro index mapping');

await test('mk2IndexToDeviceImgId(0, mirabox-k1pro) === 5 (top-left → device image 5)', () => {
  assert.equal(mk2IndexToDeviceImgId(0, MIRABOX_K1PRO_MODEL), 5);
});

await test('deviceInputToMk2Index(0x05, mirabox-k1pro) === 0', () => {
  assert.equal(deviceInputToMk2Index(0x05, MIRABOX_K1PRO_MODEL), 0);
});

await test('deviceInputToMk2Index(0x01, mirabox-k1pro) === 2', () => {
  assert.equal(deviceInputToMk2Index(0x01, MIRABOX_K1PRO_MODEL), 2);
});

await test('deviceInputToMk2Index(0x25, mirabox-k1pro) === -1 (encoder code dropped)', () => {
  assert.equal(deviceInputToMk2Index(0x25, MIRABOX_K1PRO_MODEL), -1);
});

await test('deviceInputToMk2Index(0x50, mirabox-k1pro) === -1 (encoder code dropped)', () => {
  assert.equal(deviceInputToMk2Index(0x50, MIRABOX_K1PRO_MODEL), -1);
});

summaryExit();
