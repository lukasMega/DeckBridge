import assert from 'tjs:assert';
import { hidPathsMatching, matchesHidQuery, type HidDeviceInfo } from '../src/ffi/hidapi.js';
import { cachedDiscoveryPaths, installDiscoverySnapshot } from '../src/ffi/hid-discovery.js';
import { test, summary } from './helpers/harness.js';

// Pure matcher shared by findHidPath/listHidPaths/hidDevicePresent (ffi/hidapi.ts) and
// cachedDiscoveryPaths (ffi/hid-discovery.ts) — no FFI, no hardware, just field
// comparisons against fake enumeration rows.

function row(over: Partial<HidDeviceInfo>): HidDeviceInfo {
  return {
    vendorId: 0x0fd9,
    productId: 0x0080,
    usagePage: 0xff00,
    usage: 0x01,
    interfaceNumber: 0,
    manufacturer: 'Elgato',
    product: 'Stream Deck MK.2',
    serial: 'SERIAL1',
    path: '/dev/hidraw0',
    ...over,
  };
}

console.log('\nmatchesHidQuery');

test('vendorId mismatch never matches', () => {
  assert.ok(!matchesHidQuery(row({}), { vendorId: 0xdead }));
});

test('productIds omitted matches any product ID', () => {
  assert.ok(matchesHidQuery(row({ productId: 0x1234 }), { vendorId: 0x0fd9 }));
});

test('productIds present requires membership', () => {
  const d = row({ productId: 0x0080 });
  assert.ok(matchesHidQuery(d, { vendorId: 0x0fd9, productIds: [0x0060, 0x0080] }));
  assert.ok(!matchesHidQuery(d, { vendorId: 0x0fd9, productIds: [0x0060, 0x0007] }));
});

test('usagePage/usage omitted matches any value; present requires exact match', () => {
  const d = row({ usagePage: 0xff00, usage: 0x01 });
  assert.ok(matchesHidQuery(d, { vendorId: 0x0fd9 }), 'no usage filter — matches');
  assert.ok(matchesHidQuery(d, { vendorId: 0x0fd9, usagePage: 0xff00, usage: 0x01 }));
  assert.ok(!matchesHidQuery(d, { vendorId: 0x0fd9, usagePage: 0xff00, usage: 0x02 }));
  assert.ok(!matchesHidQuery(d, { vendorId: 0x0fd9, usagePage: 0x0001, usage: 0x01 }));
});

console.log('\nhidPathsMatching');

test('filters and de-duplicates paths', () => {
  const devices = [
    row({ path: '/dev/hidraw0' }),
    row({ path: '/dev/hidraw0' }), // same physical interface enumerated twice
    row({ path: '/dev/hidraw1' }),
    row({ vendorId: 0xdead, path: '/dev/hidraw2' }),
  ];
  const paths = hidPathsMatching(devices, { vendorId: 0x0fd9 });
  assert.equal(paths.length, 2, 'de-duplicated, unrelated vendor excluded');
  assert.ok(paths.includes('/dev/hidraw0'));
  assert.ok(paths.includes('/dev/hidraw1'));
});

test('no match → empty array', () => {
  assert.equal(hidPathsMatching([row({})], { vendorId: 0xdead }).length, 0);
});

// cachedDiscoveryPaths (hid-discovery.ts) reuses the exact same matcher against its own
// snapshot cache — verify it gets the same answers for the same query shape.

console.log('\ncachedDiscoveryPaths (shares the hidapi.ts matcher)');

test('matches by vendorId + productIds[], optional usagePage/usage', () => {
  installDiscoverySnapshot([
    row({ productId: 0x0080, path: '/dev/hidraw0' }),
    row({ productId: 0x0060, path: '/dev/hidraw1' }),
    row({ vendorId: 0x3142, productId: 0x0007, path: '/dev/hidraw2' }),
  ]);
  assert.deepEqual(
    cachedDiscoveryPaths(0x0fd9, [0x0080, 0x0060]).toSorted((a, b) => a.localeCompare(b)),
    ['/dev/hidraw0', '/dev/hidraw1'],
  );
  assert.equal(cachedDiscoveryPaths(0x0fd9, [0x0060]).length, 1);
  assert.equal(cachedDiscoveryPaths(0x3142, [0x0007]).length, 1);
  assert.equal(cachedDiscoveryPaths(0xdead, [0xbeef]).length, 0);
});

test('usagePage/usage filter narrows the same snapshot', () => {
  installDiscoverySnapshot([
    row({ usagePage: 0xff00, usage: 0x01, path: '/dev/hidraw0' }),
    row({ usagePage: 0x000c, usage: 0x01, path: '/dev/hidraw1' }),
  ]);
  assert.equal(cachedDiscoveryPaths(0x0fd9, [0x0080], 0xff00, 0x01).length, 1);
  assert.equal(cachedDiscoveryPaths(0x0fd9, [0x0080]).length, 2, 'no usage filter — both rows');
});

summary();
