import assert from 'tjs:assert';
import { DockStandby, type StandbySink } from '../src/main/dock-standby.js';
import { DEFAULT_TIMING, type StandbyTiming } from '../src/main/standby-policy.js';
import { DEFAULT_STANDBY } from '../src/shared/standby-settings.js';
import type { StandbySettings } from '../src/shared/types.js';
import { testAsync as test, summary } from './helpers/harness.js';
import { FakeClock } from './helpers/fake-standby-clock.js';

const SEC = 1000;
const MIN = 60 * SEC;

interface Opts {
  settings?: Partial<StandbySettings>;
  paired?: boolean;
  canSleep?: boolean;
  canShowClock?: boolean;
  timing?: Partial<StandbyTiming>;
  client?: boolean;
}

function setup(o: Opts = {}) {
  const clock = new FakeClock();
  const calls: string[] = [];
  const settings: StandbySettings = { ...DEFAULT_STANDBY, ...o.settings };
  const link = { client: o.client ?? true, rxIdle: 0 };
  const rec =
    (name: string) =>
    (...a: unknown[]) =>
      void calls.push([name, ...a].join(':'));
  const sink: StandbySink = {
    applyBrightness: rec('bright'),
    setSleep: rec('sleep'),
    enterStandby: rec('enter'),
    exitStandby: rec('exit'),
    paintStandby: () => void calls.push('paint'),
    wakeRepaint: rec('wake'),
    runHook: rec('hook'),
    changed: rec('changed'),
  };
  const s = new DockStandby({
    settings: () => settings,
    pairedBefore: () => o.paired ?? true,
    canSleep: () => o.canSleep ?? false,
    canShowClock: () => o.canShowClock ?? true,
    link: { childHasClient: () => link.client, childRxIdleMs: () => link.rxIdle },
    sink,
    clock,
    timing: { ...DEFAULT_TIMING, ...o.timing },
  });
  s.onDriverAttached();
  s.setRequested(80);
  calls.length = 0;
  const count = (c: string): number => calls.filter((x) => x === c).length;
  const has = (prefix: string): boolean => calls.some((x) => x.startsWith(prefix));
  /** Past the boot grace, then the app leaves and the debounce elapses. */
  const appLeaves = (): void => {
    clock.advance(DEFAULT_TIMING.bootGraceMs);
    link.client = false;
    s.onAppDetached();
    clock.advance(DEFAULT_TIMING.appGoneDebounceMs);
  };
  return { s, clock, calls, settings, link, count, has, appLeaves };
}

const DIM = { idleDim: true, idleMinutes: 5, idleLevel: 10 };
const down = (mk2: number) => ({ kind: 'key', mk2, state: 'down' }) as const;
const up = (mk2: number) => ({ kind: 'key', mk2, state: 'up' }) as const;

console.log('\nidle dim and wake press');

await test('dims after idleMinutes; the waking press is swallowed and balanced', () => {
  const h = setup({ settings: DIM });
  h.clock.advance(4 * MIN + 59 * SEC);
  assert.equal(h.has('bright'), false);
  h.clock.advance(SEC);
  assert.deepEqual(
    h.calls.filter((c) => c.startsWith('bright')),
    ['bright:10'],
  );
  assert.equal(h.s.state, 'dimmed');
  assert.equal(h.s.noteInput(down(3)), true);
  assert.ok(h.calls.includes('bright:80'));
  assert.equal(h.s.noteInput(up(3)), true);
  assert.equal(h.s.noteInput(down(3)), false);
});

await test("wakePress 'forward' forwards the waking press", () => {
  const h = setup({ settings: { ...DIM, wakePress: 'forward' } });
  h.clock.advance(5 * MIN);
  assert.equal(h.s.noteInput(down(3)), false);
  assert.ok(h.calls.includes('bright:80'));
});

await test('a key held across the timeout: its up is forwarded and restores', () => {
  const h = setup({ settings: DIM });
  assert.equal(h.s.noteInput(down(3)), false);
  h.clock.advance(5 * MIN);
  assert.equal(h.s.state, 'dimmed');
  assert.equal(h.s.noteInput(up(3)), false);
  assert.equal(h.s.state, 'active');
  assert.ok(h.calls.includes('bright:80'));
});

await test('knob rotate, touch and a dial press pair also wake and are swallowed', () => {
  const h = setup({ settings: DIM });
  h.clock.advance(5 * MIN);
  assert.equal(h.s.noteInput({ kind: 'dialRotate', index: 0 }), true);
  h.clock.advance(5 * MIN);
  assert.equal(h.s.noteInput({ kind: 'touch' }), true);
  h.clock.advance(5 * MIN);
  assert.equal(h.s.noteInput({ kind: 'dialPress', index: 1, state: 'down' }), true);
  assert.equal(h.s.noteInput({ kind: 'dialPress', index: 1, state: 'up' }), true);
  h.clock.advance(5 * MIN);
  assert.equal(h.s.noteInput({ kind: 'extraKey', wireId: 16, state: 'down' }), true);
  assert.equal(h.s.noteInput({ kind: 'extraKey', wireId: 16, state: 'up' }), true);
});

await test('inputs that raise nothing are forwarded: requested 0, dim >= requested, standby', () => {
  const zero = setup({ settings: DIM });
  zero.s.setRequested(0);
  zero.clock.advance(5 * MIN);
  assert.equal(zero.s.state, 'active', 'requested 0 is not a screen-off we caused');
  assert.equal(zero.s.noteInput(down(1)), false);

  const high = setup({ settings: { ...DIM, idleLevel: 90 } });
  high.clock.advance(5 * MIN);
  assert.equal(high.s.noteInput(down(1)), false);

  const sb = setup({ settings: { appGoneAction: 'clock' } });
  sb.appLeaves();
  assert.equal(sb.s.state, 'standby');
  assert.equal(sb.s.noteInput(down(1)), false);
});

await test('a requested change while dimmed writes nothing until the waking input', () => {
  const h = setup({ settings: DIM });
  h.clock.advance(5 * MIN);
  h.calls.length = 0;
  h.s.setRequested(50);
  assert.equal(h.has('bright'), false);
  h.s.noteInput(down(1));
  assert.ok(h.calls.includes('bright:50'));
});

await test('idle ticks without a change never re-write the level', () => {
  const h = setup({ settings: DIM });
  h.clock.advance(5 * MIN);
  h.calls.length = 0;
  h.clock.advance(100 * SEC);
  assert.equal(h.has('bright'), false);
});

console.log('\napp presence');

await test('a blip under the debounce never shows standby; a real absence does, once', () => {
  const h = setup({ settings: { appGoneAction: 'clock' } });
  h.clock.advance(DEFAULT_TIMING.bootGraceMs);
  h.link.client = false;
  h.s.onAppDetached();
  h.clock.advance(14 * SEC);
  assert.equal(h.has('enter'), false);
  h.link.client = true;
  h.s.onAppAttached();
  h.clock.advance(MIN);
  assert.equal(h.has('enter'), false);
  h.link.client = false;
  h.s.onAppDetached();
  h.clock.advance(15 * SEC);
  assert.equal(h.count('enter'), 1);
  assert.equal(h.s.state, 'standby');
  assert.ok(h.calls.indexOf('bright:20') < h.calls.indexOf('enter'));
});

await test('boot grace holds standby back until it has passed', () => {
  const h = setup({ settings: { appGoneAction: 'clock' } });
  h.clock.advance(5 * SEC);
  h.link.client = false;
  h.s.onAppDetached();
  h.clock.advance(54 * SEC);
  assert.equal(h.has('enter'), false);
  h.clock.advance(SEC);
  assert.equal(h.count('enter'), 1);
});

await test('an app that is absent from the start counts as gone once the grace has passed', () => {
  const h = setup({ settings: { appGoneAction: 'clock' }, client: false });
  h.clock.advance(59 * SEC);
  assert.equal(h.has('enter'), false);
  h.clock.advance(SEC);
  assert.equal(h.count('enter'), 1);
});

await test('a never-paired deck needs a session in this process', () => {
  const h = setup({ settings: { appGoneAction: 'clock' }, paired: false });
  h.appLeaves();
  h.clock.advance(MIN);
  assert.equal(h.has('enter'), false);
  h.link.client = true;
  h.s.onAppAttached();
  h.link.client = false;
  h.s.onAppDetached();
  h.clock.advance(15 * SEC);
  assert.equal(h.count('enter'), 1);
});

await test('reconnect exits standby synchronously and restores the requested level', () => {
  const h = setup({ settings: { appGoneAction: 'clock' } });
  h.appLeaves();
  h.calls.length = 0;
  h.link.client = true;
  h.s.onAppAttached();
  assert.equal(h.count('exit'), 1);
  assert.ok(h.calls.indexOf('exit') < h.calls.indexOf('bright:80'));
  assert.equal(h.s.state, 'active');
});

await test('CORA traffic exits standby from a 0 ms timer, not synchronously', () => {
  const h = setup({ settings: { appGoneAction: 'clock' } });
  h.appLeaves();
  h.calls.length = 0;
  h.s.noteAppTraffic();
  assert.equal(h.has('exit'), false);
  h.clock.advance(0);
  assert.equal(h.count('exit'), 1);
  assert.equal(h.s.state, 'active');
});

await test('CORA silence enters standby; Companion and silenceMs 0 are exempt', () => {
  const quiet = setup({ settings: { appGoneAction: 'clock' } });
  quiet.link.rxIdle = 31 * SEC;
  quiet.clock.advance(DEFAULT_TIMING.bootGraceMs);
  assert.equal(quiet.count('enter'), 1);

  const bf = setup({ settings: { appGoneAction: 'clock' } });
  bf.link.rxIdle = 31 * SEC;
  bf.s.onClientApp('bitfocus');
  bf.clock.advance(2 * MIN);
  assert.equal(bf.has('enter'), false);

  const off = setup({ settings: { appGoneAction: 'clock' }, timing: { silenceMs: 0 } });
  off.link.rxIdle = 31 * SEC;
  off.clock.advance(2 * MIN);
  assert.equal(off.has('enter'), false);
});

await test("appGoneAction 'off': dark without painting; input stays off; return wakes", () => {
  const h = setup({ settings: { appGoneAction: 'off' } });
  h.appLeaves();
  assert.equal(h.s.state, 'off');
  assert.equal(h.s.effective, 0);
  assert.ok(h.calls.includes('bright:0'));
  assert.equal(h.has('enter'), false);
  assert.equal(h.s.noteInput(down(1)), false);
  assert.equal(h.s.state, 'off');
  h.calls.length = 0;
  h.link.client = true;
  h.s.onAppAttached();
  assert.ok(h.calls.includes('bright:80'));
  h.clock.advance(0);
  assert.ok(h.calls.includes('wake:false'));
});

await test("a browser deck (canShowClock false) treats 'clock' as 'off'", () => {
  const h = setup({ settings: { appGoneAction: 'clock' }, canShowClock: false });
  h.appLeaves();
  assert.equal(h.s.state, 'off');
  assert.equal(h.has('enter'), false);
});

console.log('\nnight mode');

await test('night caps, goes dark when idle, wakes on a swallowed press, ends at 07:00', () => {
  const h = setup({ settings: { night: true } });
  h.clock.minute = 22 * 60 + 59;
  h.clock.advance(SEC);
  assert.equal(h.s.state, 'active');
  h.clock.minute = 23 * 60;
  h.clock.advance(SEC);
  assert.equal(h.s.state, 'night');
  assert.ok(h.calls.includes('bright:10'));
  h.clock.advance(5 * MIN);
  assert.equal(h.s.state, 'off');
  assert.ok(h.calls.includes('bright:0'));
  h.calls.length = 0;
  assert.equal(h.s.noteInput(down(1)), true);
  assert.ok(h.calls.includes('bright:10'));
  h.clock.minute = 7 * 60;
  h.clock.advance(SEC);
  assert.equal(h.s.state, 'active');
  assert.ok(h.calls.includes('bright:80'));
});

console.log('\noff stage, hardware sleep, hooks');

const OFF = { ...DIM, offWhenIdle: true, offMinutes: 10 };

await test('dim at 5, off at 10 with one sleep hook; a press wakes: repaint + wake hook deferred', () => {
  const h = setup({ settings: OFF });
  h.clock.advance(5 * MIN);
  assert.equal(h.s.state, 'dimmed');
  h.clock.advance(5 * MIN);
  assert.equal(h.s.state, 'off');
  assert.ok(h.calls.includes('bright:0'));
  assert.equal(h.count('hook:sleep'), 1);
  h.clock.advance(100 * SEC);
  assert.equal(h.count('hook:sleep'), 1, 'hooks never repeat while off');
  h.calls.length = 0;
  assert.equal(h.s.noteInput(down(2)), true);
  assert.ok(h.calls.includes('bright:80'));
  assert.equal(h.has('wake'), false, 'repaint is deferred off the input path');
  h.clock.advance(0);
  assert.ok(h.calls.includes('wake:false'));
  assert.equal(h.count('hook:wake'), 1);
});

await test('hardware sleep: setSleep instead of brightness 0; wake = sleep off, level, repaint(true)', () => {
  const h = setup({ settings: OFF, canSleep: true });
  h.clock.advance(10 * MIN);
  assert.ok(h.calls.includes('sleep:true'));
  assert.equal(h.calls.includes('bright:0'), false);
  h.calls.length = 0;
  h.s.noteInput(down(2));
  assert.deepEqual(
    h.calls.filter((c) => c.startsWith('sleep') || c.startsWith('bright')),
    ['sleep:false', 'bright:80'],
  );
  h.clock.advance(0);
  assert.ok(h.calls.includes('wake:true'));
});

await test("offMode 'brightness0' never sleeps the hardware", () => {
  const h = setup({ settings: { ...OFF, offMode: 'brightness0' }, canSleep: true });
  h.clock.advance(10 * MIN);
  assert.ok(h.calls.includes('bright:0'));
  assert.equal(h.has('sleep'), false);
});

await test('painter pauses while off and resumes on wake', () => {
  const h = setup({ settings: { appGoneAction: 'clock', offWhenIdle: true, offMinutes: 10 } });
  h.appLeaves();
  assert.equal(h.count('enter'), 1);
  h.clock.advance(10 * MIN);
  assert.equal(h.s.state, 'off');
  h.calls.length = 0;
  h.clock.advance(3 * MIN);
  assert.equal(h.has('paint'), false);
  h.s.noteInput(down(1));
  h.clock.advance(0);
  assert.equal(h.count('paint'), 1);
});

console.log('\nrecovery and lifecycle');

await test('a frozen process (host sleep) counts as activity and re-applies once', () => {
  const h = setup({ settings: DIM });
  h.clock.jump(10 * MIN);
  h.clock.advance(SEC);
  assert.equal(h.s.state, 'active');
  assert.equal(h.count('bright:80'), 1);
});

await test("a device 'reinit' re-writes the effective level", () => {
  const h = setup({ settings: DIM });
  h.clock.advance(5 * MIN);
  h.calls.length = 0;
  h.s.onDeviceReinit();
  assert.deepEqual(
    h.calls.filter((c) => c.startsWith('bright')),
    ['bright:10'],
  );
});

await test('an explicit uncapped setRequested writes through even when unchanged', () => {
  const h = setup();
  h.s.setRequested(80);
  assert.ok(h.calls.includes('bright:80'));
});

await test('reload: turning everything off stops the tick and restores the level', () => {
  const h = setup({ settings: DIM });
  h.clock.advance(5 * MIN);
  assert.equal(h.clock.pendingIntervals(), 1);
  h.settings.idleDim = false;
  h.calls.length = 0;
  h.s.reload();
  assert.equal(h.clock.pendingIntervals(), 0);
  assert.ok(h.calls.includes('bright:80'));
});

await test("reload to appGoneAction 'none' while in standby exits standby", () => {
  const h = setup({ settings: { appGoneAction: 'clock' } });
  h.appLeaves();
  h.settings.appGoneAction = 'none';
  h.calls.length = 0;
  h.s.reload();
  assert.equal(h.count('exit'), 1);
  assert.equal(h.s.state, 'active');
});

await test('a driver detach drops the swallow set and standby paint state silently', () => {
  const h = setup({ settings: DIM });
  h.clock.advance(5 * MIN);
  h.s.noteInput(down(4));
  h.s.onDriverDetached();
  h.calls.length = 0;
  h.s.onDriverAttached();
  assert.equal(h.s.noteInput(up(4)), false, 'stale swallow tag was cleared');
  assert.equal(h.has('hook'), false);
});

await test('a swallowed down whose up was lost does not eat the next press up', () => {
  const h = setup({ settings: DIM });
  h.clock.advance(5 * MIN);
  assert.equal(h.s.noteInput(down(4)), true, 'waking down swallowed');
  // Its up never arrives; later a normal press on the same key.
  assert.equal(h.s.noteInput(down(4)), false);
  assert.equal(h.s.noteInput(up(4)), false, 'the real press up is forwarded');
});

await test('a re-attach after the sleep hook ran fires the wake hook once', () => {
  const h = setup({ settings: { offWhenIdle: true, offMinutes: 1 } });
  h.clock.advance(MIN);
  assert.equal(h.s.state, 'off');
  assert.equal(h.count('hook:sleep'), 1);
  h.s.onDriverDetached();
  h.calls.length = 0;
  h.s.onDriverAttached();
  assert.equal(h.s.state, 'active');
  assert.equal(h.count('hook:wake'), 1);
  h.clock.advance(MIN - SEC);
  h.s.noteInput(down(1));
  h.clock.advance(0);
  assert.equal(h.count('hook:wake'), 1, 'not again');
});

await test('no hooks on a fresh attach where sleep never ran', () => {
  const h = setup({ settings: { offWhenIdle: true, offMinutes: 1 } });
  h.s.onDriverDetached();
  h.calls.length = 0;
  h.s.onDriverAttached();
  h.clock.advance(0);
  assert.equal(h.has('hook'), false);
});

await test('a new app session forgets Companion, so CORA silence is detected again', () => {
  const h = setup({ settings: { appGoneAction: 'clock' } });
  h.link.rxIdle = 31 * SEC;
  h.s.onClientApp('bitfocus');
  h.clock.advance(DEFAULT_TIMING.bootGraceMs);
  assert.equal(h.has('enter'), false, 'exempt while Companion');
  h.s.onAppDetached();
  h.s.onAppAttached();
  h.clock.advance(2 * MIN);
  assert.equal(h.count('enter'), 1);

  const g = setup({ settings: { appGoneAction: 'clock' } });
  g.link.rxIdle = 31 * SEC;
  g.s.onClientApp('bitfocus');
  g.s.onAppAttached();
  g.clock.advance(2 * MIN);
  assert.equal(g.count('enter'), 1, 'attach alone resets it');
});

await test('stop() clears every timer', () => {
  const h = setup({ settings: { ...DIM, appGoneAction: 'clock' }, client: false });
  h.clock.advance(DEFAULT_TIMING.bootGraceMs);
  h.s.noteAppTraffic();
  assert.ok(h.clock.pending() >= 2, 'tick + pending exit');
  h.s.stop();
  assert.equal(h.clock.pending(), 0);
});

summary();
