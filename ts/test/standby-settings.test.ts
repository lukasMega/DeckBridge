import assert from 'tjs:assert';
import {
  DEFAULT_STANDBY,
  formatHhmm,
  parseHhmm,
  pickStandbyKeys,
  publicStandby,
  resolveStandby,
  standbySettingsError,
} from '../src/shared/standby-settings.js';
import { test, summary } from './helpers/harness.js';

console.log('\nstandby-settings');

test('defaults are valid and everything is off', () => {
  assert.equal(standbySettingsError({}), null);
  assert.equal(standbySettingsError({ ...DEFAULT_STANDBY }), null);
  const s = resolveStandby(undefined);
  assert.deepEqual(s, DEFAULT_STANDBY);
  assert.equal(s.idleDim, false);
  assert.equal(s.offWhenIdle, false);
  assert.equal(s.night, false);
  assert.equal(s.pixelShift, false);
  assert.equal(s.offMode, 'auto');
  assert.equal(s.appGoneAction, 'none');
  assert.equal(s.wakePress, 'swallow');
});

test('resolveStandby overlays a partial on the defaults', () => {
  const s = resolveStandby({ idleDim: true, idleMinutes: 3 });
  assert.equal(s.idleDim, true);
  assert.equal(s.idleMinutes, 3);
  assert.equal(s.idleLevel, DEFAULT_STANDBY.idleLevel);
});

const bad: Array<[string, Record<string, unknown>]> = [
  ['idleLevel 101', { idleLevel: 101 }],
  ['idleLevel -1', { idleLevel: -1 }],
  ['idleLevel 0', { idleLevel: 0 }],
  ['clockLevel 0', { clockLevel: 0 }],
  ['nightLevel 0', { nightLevel: 0 }],
  ['idleMinutes 0', { idleMinutes: 0 }],
  ['idleMinutes 241', { idleMinutes: 241 }],
  ['idleMinutes 1.5', { idleMinutes: 1.5 }],
  ['idleMinutes string', { idleMinutes: '5' }],
  ['offMinutes 1441', { offMinutes: 1441 }],
  ['offMinutes 0', { offMinutes: 0 }],
  ['offMode sleep', { offMode: 'sleep' }],
  ['appGoneAction x', { appGoneAction: 'x' }],
  ['wakePress x', { wakePress: 'x' }],
  ['wakeCommand empty', { wakeCommand: '' }],
  ['sleepCommand too long', { sleepCommand: 'x'.repeat(1025) }],
  ['sleepCommand number', { sleepCommand: 5 }],
  ['idleDim string', { idleDim: 'yes' }],
  ['nightStart 24:00', { nightStart: '24:00' }],
  ['nightStart 7:00', { nightStart: '7:00' }],
  ['nightEnd 07:60', { nightEnd: '07:60' }],
  ['nightStart === nightEnd', { nightStart: '08:00', nightEnd: '08:00' }],
  ['nightStart equals default nightEnd', { nightStart: '07:00' }],
  [
    'offMinutes <= idleMinutes',
    { idleDim: true, offWhenIdle: true, idleMinutes: 10, offMinutes: 10 },
  ],
];
for (const [name, v] of bad) {
  test(`rejects ${name}`, () => {
    assert.ok(standbySettingsError(v) !== null, 'expected an error');
  });
}

test('rejects non-objects', () => {
  assert.ok(standbySettingsError(null) !== null);
  assert.ok(standbySettingsError([]) !== null);
  assert.ok(standbySettingsError('x') !== null);
});

test('accepts boundary values', () => {
  assert.equal(
    standbySettingsError({ idleMinutes: 1, idleLevel: 1, offMinutes: 1440, nightStart: '00:00' }),
    null,
  );
  assert.equal(standbySettingsError({ idleMinutes: 240, idleLevel: 100, nightEnd: '23:59' }), null);
});

test('offMinutes <= idleMinutes is fine while idleDim is off', () => {
  assert.equal(
    standbySettingsError({ idleDim: false, offWhenIdle: true, idleMinutes: 10, offMinutes: 5 }),
    null,
  );
});

test('unknown keys are valid and ignored by resolveStandby', () => {
  const v = { idleDim: true, futureThing: 7 };
  assert.equal(standbySettingsError(v), null);
  assert.equal('futureThing' in resolveStandby(v), false);
  assert.equal('futureThing' in pickStandbyKeys(v), false);
});

test('pickStandbyKeys drops sleepCommand/wakeCommand; publicStandby omits them', () => {
  const picked = pickStandbyKeys({ idleDim: true, sleepCommand: 'a', wakeCommand: 'b' });
  assert.deepEqual(picked, { idleDim: true });
  const pub = publicStandby(resolveStandby({ sleepCommand: 'a', wakeCommand: 'b' }));
  assert.equal('sleepCommand' in pub, false);
  assert.equal('wakeCommand' in pub, false);
  assert.equal(pub.idleMinutes, DEFAULT_STANDBY.idleMinutes);
});

test('parseHhmm / formatHhmm', () => {
  assert.equal(parseHhmm('00:00'), 0);
  assert.equal(parseHhmm('23:59'), 1439);
  assert.equal(parseHhmm('07:30'), 450);
  assert.equal(parseHhmm('7:00'), undefined);
  assert.equal(parseHhmm(450), undefined);
  assert.equal(formatHhmm(0), '00:00');
  assert.equal(formatHhmm(1439), '23:59');
  for (const m of [0, 59, 60, 450, 1439]) assert.equal(parseHhmm(formatHhmm(m)), m);
});

summary();
