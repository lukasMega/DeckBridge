import assert from 'tjs:assert';
import { isNativeMdnsAvailable, mdnsAdvertiseStart, mdnsAdvertiseStop } from '../src/ffi/mdns.js';

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

// The mdns_advertise_start/_stop symbols are compiled into libdeckbridge_native
// only for target_os=windows (rust/deckbridge-native/src/mdns_windows.rs), so on
// this platform's build they are absent — these tests verify the graceful
// fallback behavior that macOS/Linux actually run in production, not a mock.

console.log('\nffi/mdns (non-Windows build: native symbols absent)');

await test('isNativeMdnsAvailable() returns false without throwing', () => {
  const avail = isNativeMdnsAvailable();
  assert.equal(typeof avail, 'boolean');
  assert.equal(avail, false);
});

await test('mdnsAdvertiseStart() returns false gracefully when native symbols are absent', () => {
  const ok = mdnsAdvertiseStart('test-service', '_elg._tcp', 5343, 'dt=1\nvid=4057');
  assert.equal(ok, false);
});

await test('mdnsAdvertiseStop() is a safe no-op when nothing was started', () => {
  mdnsAdvertiseStop();
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) tjs.exit(1);
