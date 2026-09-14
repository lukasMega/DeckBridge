import assert from 'tjs:assert';
import { hidSnapshot, invalidateHidSnapshot } from '../src/ffi/hidapi.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

// Runs against the real deckbridge-native enumeration (like ffi-mdns.test.ts), so it
// asserts only device-independent behavior: the CACHING, which is the whole point.
// Before this cache every VID/PID-filtered query ran its own full hid_enumerate — ~26
// of them per presence sweep, every 2 s, on the main thread (issue #67.2).

console.log('\nffi/hidapi enumeration snapshot');

await test('a second query inside the TTL reuses the same enumeration', () => {
  invalidateHidSnapshot();
  const first = hidSnapshot();
  const second = hidSnapshot();
  assert.ok(first === second, 'same array instance — no second native enumeration');
});

await test('maxAgeMs 0 forces a fresh enumeration', () => {
  const cached = hidSnapshot();
  const fresh = hidSnapshot(0);
  assert.ok(cached !== fresh, 'a new array instance');
  assert.equal(fresh.length, cached.length, 'same devices, nothing plugged in between');
});

await test('invalidateHidSnapshot() drops the cache', () => {
  const before = hidSnapshot();
  invalidateHidSnapshot();
  assert.ok(hidSnapshot() !== before, 're-enumerated after invalidation');
});

await test('every row carries the fields presence/path matching needs', () => {
  for (const d of hidSnapshot()) {
    assert.equal(typeof d.vendorId, 'number', 'vendorId');
    assert.equal(typeof d.productId, 'number', 'productId');
    assert.equal(typeof d.usagePage, 'number', 'usagePage');
    assert.equal(typeof d.usage, 'number', 'usage');
    assert.ok(d.path.length > 0, 'a non-empty path');
    assert.ok(!Number.isNaN(d.vendorId), 'vendorId parsed from hex');
    assert.ok(!Number.isNaN(d.productId), 'productId parsed from hex');
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) tjs.exit(1);
