import assert from 'tjs:assert';
import { buildArgs, MdnsAdvertiser } from '../src/mdns-advertiser.js';
import { MDNS_SERVICE_NAME } from '../src/types.js';
import { platformName } from '../src/os-utils.ts';

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

// ── buildArgs ──────────────────────────────────────────────────────────────

console.log('\nbuildArgs');

const txt = { dt: '215', vid: '4057', pid: '128', sn: 'ABC123' };

await test('Linux → avahi-publish-service', () => {
  const args = buildArgs('Linux', 'Network Stream Deck', 5343, txt);
  assert.equal(args[0], 'avahi-publish-service');
  assert.ok(args.includes('_elg._tcp'));
  assert.ok(args.includes('5343'));
});

await test('macOS → dns-sd', () => {
  const args = buildArgs('macOS', 'Network Stream Deck', 5343, txt);
  assert.equal(args[0], 'dns-sd');
  assert.ok(args.includes('-R'));
});

await test('empty/unknown platform falls through to the dns-sd default branch without throwing', () => {
  const args = buildArgs('', 'Network Stream Deck', 5343, txt);
  assert.equal(args[0], 'dns-sd');
  assert.ok(args.length > 0, 'returns a non-empty arg list');
});

// ── MdnsAdvertiser serviceName ───────────────────────────────────────────────

console.log('\nMdnsAdvertiser serviceName');

// tjs.spawn is read-only, so we can't intercept the spawned argv directly.
// start() logs `mDNS: spawning <bin> for <serviceName> on port <port>` right
// before spawning, so the resolved serviceName is observable via the LogFn.
// Kill the (real) subprocess immediately via stop().

await test('serviceName constructor arg appears in the spawn log', async () => {
  let spawnLog = '';
  const adv = new MdnsAdvertiser(
    5343,
    (_level, message) => {
      if (message.startsWith('mDNS: spawning')) spawnLog = message;
    },
    'My Custom Deck',
  );
  try {
    await adv.start();
  } finally {
    adv.stop();
  }
  assert.ok(spawnLog.includes('My Custom Deck'), 'custom serviceName should be in spawn log');
});

await test('serviceName defaults to MDNS_SERVICE_NAME when omitted', async () => {
  let spawnLog = '';
  const adv = new MdnsAdvertiser(5343, (_level, message) => {
    if (message.startsWith('mDNS: spawning')) spawnLog = message;
  });
  try {
    await adv.start();
  } finally {
    adv.stop();
  }
  assert.ok(spawnLog.includes(MDNS_SERVICE_NAME), 'default serviceName should be in spawn log');
});

// ── platformName ───────────────────────────────────────────────────────────

console.log('\nplatformName');

await test('returns a string without throwing', () => {
  const name = platformName();
  assert.equal(typeof name, 'string');
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) tjs.exit(1);
