import assert from 'tjs:assert';
import { selectedCoraProfile } from '../src/web/client/ui-helpers.js';
import type { Status } from '../src/web/client/ui-types.js';
import { test, summaryExit } from './helpers/harness.js';

const baseStatus: Status = {
  driverMode: 'real',
  driverConnected: true,
  elgatoConnected: true,
  docks: [],
};

// selectedCoraProfile

console.log('\nselectedCoraProfile');

test('reads the selected dock, absent when native or no docks', () => {
  const dock = {
    index: 0,
    modelId: 'ajazz-akp05e',
    modelName: 'AJAZZ AKP05E',
    keyCount: 10,
    columns: 5,
    rows: 2,
    primaryPort: 5343,
    primaryConnected: true,
    elgatoConnected: true,
    brightness: 100,
  };
  const plus = { ...dock, index: 1, coraProfile: 'stream-deck-plus' };
  const docks = [dock, plus];
  assert.equal(selectedCoraProfile({ ...baseStatus, docks, selectedDock: 1 }), 'stream-deck-plus');
  assert.equal(selectedCoraProfile({ ...baseStatus, docks }), undefined, 'dock 0 is native');
  assert.equal(selectedCoraProfile(baseStatus), undefined, 'no docks');
});

// Summary

summaryExit();
