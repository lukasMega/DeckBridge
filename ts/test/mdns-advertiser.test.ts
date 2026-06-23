import assert from 'tjs:assert';
import { buildArgs, platformName } from '../src/mdns-advertiser.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

// ── buildArgs ──────────────────────────────────────────────────────────────

console.log('\nbuildArgs');

const txt = { dt: '215', vid: '4057', pid: '128', sn: 'ABC123' };

test('Linux → avahi-publish-service', () => {
  const args = buildArgs('Linux', 'Network Stream Deck', 5343, txt);
  assert.equal(args[0], 'avahi-publish-service');
  assert.ok(args.includes('_elg._tcp'));
  assert.ok(args.includes('5343'));
});

test('macOS → dns-sd', () => {
  const args = buildArgs('macOS', 'Network Stream Deck', 5343, txt);
  assert.equal(args[0], 'dns-sd');
  assert.ok(args.includes('-R'));
});

test('empty/unknown platform falls through to the dns-sd default branch without throwing', () => {
  const args = buildArgs('', 'Network Stream Deck', 5343, txt);
  assert.equal(args[0], 'dns-sd');
  assert.ok(args.length > 0, 'returns a non-empty arg list');
});

// ── platformName ───────────────────────────────────────────────────────────

console.log('\nplatformName');

test('returns a string without throwing', () => {
  const name = platformName();
  assert.equal(typeof name, 'string');
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) tjs.exit(1);
