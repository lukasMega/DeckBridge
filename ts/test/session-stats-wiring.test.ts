import assert from 'tjs:assert';
import { statsHooks } from '../src/main/session-stats-wiring.js';
import type { Dock } from '../src/main/dock.js';
import { SessionStats } from '../src/web/server/session-stats.js';
import { DEFAULT_MODEL } from '../src/devices/registry.js';
import { AJAZZ_AKP05E_MODEL } from '../src/devices/ajazz/akp05e.js';
import { applyModelOverrides } from '../src/devices/model-overrides.js';
import type { DeviceModel } from '../src/devices/driver.js';
import { VIRTUAL_DOCK_INDEX } from '../src/shared/types.js';
import { test, summary } from './helpers/harness.js';

const byText = (a: string, b: string): number => a.localeCompare(b);

function setup(model: DeviceModel, index = 1, deviceKey: string | null = 'dk') {
  const stats = new SessionStats();
  const dock = { model, identity: deviceKey === null ? undefined : { deviceKey } } as Dock;
  const hooks = statsHooks(stats, index, () => dock);
  return { stats, hooks };
}

console.log('\nsession-stats-wiring');

test('a grid key is labelled R/C from the advertised columns (5 columns)', () => {
  const { stats, hooks } = setup(DEFAULT_MODEL);
  hooks.attached!(false);
  hooks.input!({ kind: 'key', mk2: 7, state: 'down' }); // row 1, col 2 (0-based)
  hooks.input!({ kind: 'key', mk2: 7, state: 'up' });
  hooks.input!({ kind: 'key', mk2: 0, state: 'down' });
  const d = stats.snapshot().decks[0]!;
  assert.equal(d.keyPresses, 2);
  assert.deepEqual(d.keys.map((k) => k.label).toSorted(byText), ['R1 C1', 'R2 C3']);
});

test('an extra key is labelled by its 1-based position in keyMap.extraKeys', () => {
  const plus = applyModelOverrides(AJAZZ_AKP05E_MODEL, {
    cora: { advertiseAs: 'stream-deck-plus' },
  });
  const { stats, hooks } = setup(plus);
  hooks.attached!(false);
  hooks.input!({ kind: 'extraKey', wireId: 10, state: 'down' });
  hooks.input!({ kind: 'extraKey', wireId: 99, state: 'down' }); // not in the map
  const labels = stats
    .snapshot()
    .decks[0]!.keys.map((k) => k.label)
    .toSorted(byText);
  assert.deepEqual(labels, ['Extra 2', 'Extra 99']);
});

test('dial press, rotation and image events reach the deck', () => {
  const { stats, hooks } = setup(AJAZZ_AKP05E_MODEL);
  hooks.attached!(false);
  hooks.input!({ kind: 'dialPress', index: 0, state: 'down' });
  hooks.input!({ kind: 'dialRotate', index: 0, delta: -3 });
  hooks.input!({ kind: 'touch' });
  hooks.imageSent!(2, true);
  const d = stats.snapshot().decks[0]!;
  assert.equal(d.hasEncoders, true);
  assert.equal(d.dialPresses, 1);
  assert.equal(d.dialDetents, 3);
  assert.equal(d.imagesProcessed, 1);
  assert.equal(d.cacheHits, 1);
});

test('source: usb, mock and the browser deck (VIRTUAL_DOCK_INDEX)', () => {
  const usb = setup(DEFAULT_MODEL);
  usb.hooks.attached!(false);
  assert.equal(usb.stats.snapshot().decks[0]!.source, 'usb');
  const mock = setup(DEFAULT_MODEL);
  mock.hooks.attached!(true);
  assert.equal(mock.stats.snapshot().decks[0]!.source, 'mock');
  const browser = setup(DEFAULT_MODEL, VIRTUAL_DOCK_INDEX);
  browser.hooks.attached!(false);
  assert.equal(browser.stats.snapshot().decks[0]!.source, 'browser');
});

test('a dock without identity records nothing', () => {
  const { stats, hooks } = setup(DEFAULT_MODEL, 1, null);
  hooks.attached!(false);
  hooks.input!({ kind: 'key', mk2: 0, state: 'down' });
  hooks.imageSent!(0, false);
  assert.equal(stats.snapshot().decks.length, 0);
});

summary();
