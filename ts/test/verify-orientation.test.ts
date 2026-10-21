import assert from 'tjs:assert';
import { frameOrientation } from '../src/web/server/verify-orientation.js';
import { advertisedModel, CORA_PROFILES, DEVICE_MODELS } from '../src/devices/registry.js';
import { applyModelOverrides, emulationProfiles } from '../src/devices/model-overrides.js';
import { test, summary } from './helpers/harness.js';

console.log('\nverify-orientation: P table vs the registry');

test('every advertised profile of every model (and every emulation) has a P', () => {
  const profiles = new Set<string>();
  for (const model of DEVICE_MODELS) {
    profiles.add(advertisedModel(model).id);
    for (const profile of emulationProfiles(model)) {
      const emulated = applyModelOverrides(model, { cora: { advertiseAs: profile.id } });
      profiles.add(advertisedModel(emulated).id);
    }
  }
  for (const profile of CORA_PROFILES) profiles.add(profile.id);
  for (const id of profiles) assert.ok(frameOrientation(id), `no frame orientation for '${id}'`);
});

test('P matches the hardware-derived table (plan O1)', () => {
  assert.deepEqual(frameOrientation('mk2'), { rotate: 180, flipH: false });
  assert.deepEqual(frameOrientation('mini'), { rotate: 90, flipH: true });
  assert.deepEqual(frameOrientation('stream-deck-plus'), { rotate: 0, flipH: false });
});

test('unknown or prototype ids resolve to nothing, and callers get a copy', () => {
  assert.equal(frameOrientation('nope'), undefined);
  assert.equal(frameOrientation('toString'), undefined);
  frameOrientation('mk2')!.rotate = 0;
  assert.equal(frameOrientation('mk2')!.rotate, 180, 'the table is not mutable through a result');
});

summary();
