import assert from 'tjs:assert';
import { deriveDocks } from '../src/web/client/ui-helpers.js';
import type { Status } from '../src/web/client/ui-types.js';

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

const baseStatus: Status = {
  driverMode: 'real',
  driverConnected: true,
  elgatoConnected: true,
};

// ── deriveDocks ─────────────────────────────────────────────────────────────

console.log('\nderiveDocks');

test('docks present and non-empty → passthrough', () => {
  const docks = [
    {
      index: 0,
      modelId: 'streamdeck-mk2',
      modelName: 'Stream Deck MK.2',
      keyCount: 15,
      columns: 5,
      rows: 3,
      primaryPort: 5343,
      primaryConnected: true,
      elgatoConnected: true,
    },
    {
      index: 1,
      modelId: 'streamdeck-mini',
      modelName: 'Stream Deck Mini',
      keyCount: 6,
      columns: 3,
      rows: 2,
      primaryPort: 5344,
      primaryConnected: false,
      elgatoConnected: false,
    },
  ];
  const s: Status = { ...baseStatus, docks };
  assert.equal(deriveDocks(s), docks);
});

test('legacy synthesis, driver connected → single entry from legacy fields', () => {
  const s: Status = {
    ...baseStatus,
    keyCount: 32,
    columns: 8,
    modelId: 'streamdeck-xl',
    modelName: 'Stream Deck XL',
    elgatoConnected: true,
  };
  const docks = deriveDocks(s);
  assert.equal(docks.length, 1);
  assert.equal(docks[0]!.index, 0);
  assert.equal(docks[0]!.modelId, 'streamdeck-xl');
  assert.equal(docks[0]!.modelName, 'Stream Deck XL');
  assert.equal(docks[0]!.keyCount, 32);
  assert.equal(docks[0]!.columns, 8);
  assert.equal(docks[0]!.rows, 4);
  assert.equal(docks[0]!.primaryPort, 5343);
  assert.equal(docks[0]!.elgatoConnected, true);
});

test('legacy synthesis, driver connected, missing model fields → fallback defaults', () => {
  const s: Status = {
    driverMode: 'real',
    driverConnected: true,
    elgatoConnected: false,
  };
  const docks = deriveDocks(s);
  assert.equal(docks.length, 1);
  assert.equal(docks[0]!.modelId, '');
  assert.equal(docks[0]!.modelName, 'Stream Deck MK.2');
  assert.equal(docks[0]!.keyCount, 15);
  assert.equal(docks[0]!.columns, 5);
  assert.equal(docks[0]!.rows, 3);
  assert.equal(docks[0]!.elgatoConnected, false);
});

test('legacy synthesis, driver NOT connected → empty result', () => {
  const s: Status = {
    driverMode: 'real',
    driverConnected: false,
    elgatoConnected: false,
  };
  assert.equal(deriveDocks(s).length, 0);
});

test('empty docks array → falls through to legacy synthesis', () => {
  const s: Status = { ...baseStatus, docks: [] };
  const docks = deriveDocks(s);
  assert.equal(docks.length, 1);
  assert.equal(docks[0]!.index, 0);
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
tjs.exit(failed > 0 ? 1 : 0);
