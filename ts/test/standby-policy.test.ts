import assert from 'tjs:assert';
import {
  clockSlotAt,
  computeDisplay,
  DEFAULT_TIMING,
  inNightWindow,
  PIXEL_SHIFT_ORBIT,
  pixelShiftAt,
  standbyTiming,
  SYSTEM_CLOCK,
} from '../src/main/standby-policy.js';
import type { CapInput } from '../src/main/standby-policy.js';
import { DEFAULT_STANDBY, parseHhmm } from '../src/shared/standby-settings.js';
import type { StandbySettings } from '../src/shared/types.js';
import { test, summary } from './helpers/harness.js';

const hm = (s: string): number => parseHhmm(s)!;

console.log('\ninNightWindow');

test('same-day window [09:00, 17:00)', () => {
  const [a, b] = [hm('09:00'), hm('17:00')];
  assert.equal(inNightWindow(hm('08:59'), a, b), false);
  assert.equal(inNightWindow(hm('09:00'), a, b), true);
  assert.equal(inNightWindow(hm('16:59'), a, b), true);
  assert.equal(inNightWindow(hm('17:00'), a, b), false);
});

test('midnight-crossing window [23:00, 07:00)', () => {
  const [a, b] = [hm('23:00'), hm('07:00')];
  assert.equal(inNightWindow(hm('22:59'), a, b), false);
  assert.equal(inNightWindow(hm('23:00'), a, b), true);
  assert.equal(inNightWindow(hm('00:00'), a, b), true);
  assert.equal(inNightWindow(hm('06:59'), a, b), true);
  assert.equal(inNightWindow(hm('07:00'), a, b), false);
});

const seq = (win: [string, string], times: string[]): boolean[] =>
  times.map((t) => inNightWindow(hm(t), hm(win[0]), hm(win[1])));

test('DST spring forward (wall clock jumps 01:59 -> 03:00)', () => {
  const times = ['01:58', '01:59', '03:00', '03:01'];
  assert.deepEqual(seq(['02:30', '06:00'], times), [false, false, true, true]);
  assert.deepEqual(seq(['01:00', '02:30'], times), [true, true, false, false]);
  assert.deepEqual(
    seq(['02:00', '02:59'], times).some((v) => v),
    false,
    'a window inside the skipped hour never opens that night',
  );
});

test('DST fall back (01:00-01:59 happens twice): window re-entered once', () => {
  const times = ['01:29', '01:30', '01:59', '01:00', '01:29', '01:30'];
  assert.deepEqual(seq(['23:00', '01:30'], times), [true, false, false, true, true, false]);
});

console.log('\ncomputeDisplay');

const base = (over: Partial<CapInput> = {}, s: Partial<StandbySettings> = {}): CapInput => ({
  requested: 80,
  idle: false,
  offIdle: false,
  nightActive: false,
  appGone: 'none',
  settings: { ...DEFAULT_STANDBY, ...s },
  ...over,
});

const cases: Array<[string, CapInput, { effective: number; state: string }]> = [
  ['active', base(), { effective: 80, state: 'active' }],
  ['idle + idleDim', base({ idle: true }, { idleDim: true }), { effective: 10, state: 'dimmed' }],
  [
    'idle level above requested',
    base({ idle: true }, { idleDim: true, idleLevel: 90 }),
    { effective: 80, state: 'active' },
  ],
  ['idle without idleDim', base({ idle: true }), { effective: 80, state: 'active' }],
  ['night only', base({ nightActive: true }), { effective: 10, state: 'night' }],
  [
    'night + idle + nightOffWhenIdle',
    base({ nightActive: true, idle: true }, { nightOffWhenIdle: true }),
    { effective: 0, state: 'off' },
  ],
  [
    'night + idle, dim lower than night',
    base(
      { nightActive: true, idle: true },
      { nightOffWhenIdle: false, idleDim: true, idleLevel: 5 },
    ),
    { effective: 5, state: 'dimmed' },
  ],
  [
    'night + idle, night lower than dim',
    base(
      { nightActive: true, idle: true },
      { nightOffWhenIdle: false, idleDim: true, idleLevel: 50 },
    ),
    { effective: 10, state: 'night' },
  ],
  ['appGone clock', base({ appGone: 'clock' }), { effective: 20, state: 'standby' }],
  [
    'appGone clock + night',
    base({ appGone: 'clock', nightActive: true }),
    { effective: 10, state: 'standby' },
  ],
  ['appGone off', base({ appGone: 'off' }), { effective: 0, state: 'off' }],
  ['offIdle', base({ idle: true, offIdle: true }), { effective: 0, state: 'off' }],
  [
    'idle dim, not yet offIdle',
    base({ idle: true }, { idleDim: true, offWhenIdle: true }),
    { effective: 10, state: 'dimmed' },
  ],
  ['requested 0', base({ requested: 0 }), { effective: 0, state: 'active' }],
  [
    'requested 0 with dim',
    base({ requested: 0, idle: true }, { idleDim: true }),
    { effective: 0, state: 'active' },
  ],
  [
    'clock level above requested still reports standby',
    base({ appGone: 'clock', requested: 5 }),
    { effective: 5, state: 'standby' },
  ],
];
for (const [name, input, want] of cases) {
  test(name, () => assert.deepEqual(computeDisplay(input), want));
}

console.log('\npixel shift');

test('orbit advances once per period and wraps after 8', () => {
  const p = 300_000;
  for (let i = 0; i < 16; i++) {
    assert.deepEqual(pixelShiftAt(i * p, p), PIXEL_SHIFT_ORBIT[i % 8]);
    assert.deepEqual(pixelShiftAt(i * p + p - 1, p), PIXEL_SHIFT_ORBIT[i % 8]);
  }
  assert.deepEqual(pixelShiftAt(8 * p, p), [0, 0]);
});

test('every offset stays within [-1, 1]', () => {
  for (const [dx, dy] of PIXEL_SHIFT_ORBIT) {
    assert.ok(Math.abs(dx) <= 1 && Math.abs(dy) <= 1);
  }
  assert.equal(new Set(PIXEL_SHIFT_ORBIT.map((o) => o.join(','))).size, 8);
});

console.log('\nclockSlotAt');

test('5x3 grid: only valid pair starts, every start visited', () => {
  const seen = new Set<number>();
  for (let n = 29_000_000; n < 29_000_060; n++) {
    const i = clockSlotAt(n, 5, 15);
    assert.ok(i >= 0 && i < 15 && i % 5 <= 3, `start ${i} would wrap the row`);
    seen.add(i);
  }
  assert.equal(seen.size, 12);
});

test('4x2 grid (Plus) and 1-column grids stay in range', () => {
  for (let n = 0; n < 60; n++) {
    const i = clockSlotAt(n, 4, 8);
    assert.ok(i % 4 <= 2 && i < 8);
    assert.ok(clockSlotAt(n, 1, 6) < 6);
  }
});

test('step stays coprime for slot counts that are multiples of 7', () => {
  const seen = new Set<number>();
  for (let n = 0; n < 14; n++) seen.add(clockSlotAt(n, 1, 14));
  assert.equal(seen.size, 14);
});

test('deterministic and degenerate-safe', () => {
  assert.equal(clockSlotAt(123, 5, 15), clockSlotAt(123, 5, 15));
  assert.equal(clockSlotAt(5, 3, 1), 0);
  assert.equal(clockSlotAt(5, 5, 0), 0);
});

console.log('\ntiming');

test('release timing outside fast mode; system clock reads local minute', () => {
  assert.deepEqual(standbyTiming(), DEFAULT_TIMING);
  const m = SYSTEM_CLOCK.localMinuteOfDay(Date.now());
  assert.ok(Number.isInteger(m) && m >= 0 && m < 1440);
});

summary();
