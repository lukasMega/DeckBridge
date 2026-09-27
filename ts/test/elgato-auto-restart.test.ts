import assert from 'tjs:assert';
import { ElgatoAutoRestart } from '../src/main/elgato-auto-restart.js';
import type { ElgatoAutoRestartDeps } from '../src/main/elgato-auto-restart.js';
import type { RestartResult } from '../src/infra/elgato-app.js';
import { testAsync as test, summary } from './helpers/harness.js';

/** In-memory fake of every injected dep, plus a manually-fired timer (no real
 *  setTimeout — the design has at most one shared timer live at a time, so
 *  tracking a single pending callback is enough to drive every test). */
function fakeDeps(overrides: { enabled?: boolean; delayS?: number; mock?: boolean } = {}) {
  const calls: string[] = [];
  const state = {
    enabled: overrides.enabled ?? true,
    delayS: overrides.delayS ?? 10,
    mock: overrides.mock ?? false,
    paired: new Set<string>(),
    attached: new Set<number>(),
    conflict: false,
    running: true,
    restartResult: { ok: true, killed: false } as RestartResult,
  };
  let timerFn: (() => void) | null = null;
  let timerCleared = false;
  let timerCount = 0;

  const deps: ElgatoAutoRestartDeps = {
    app: {
      isRunning: () => {
        calls.push('isRunning');
        return Promise.resolve(state.running);
      },
      restart: () => {
        calls.push('restart');
        return Promise.resolve(state.restartResult);
      },
    },
    settings: {
      enabled: () => state.enabled,
      delayS: () => state.delayS,
      wasPaired: (deviceKey: string) => state.paired.has(deviceKey),
    },
    isAttached: (dock: number) => state.attached.has(dock),
    conflict: () => state.conflict,
    mock: () => state.mock,
    setTimer: (fn, _ms) => {
      timerCount++;
      timerFn = fn;
      timerCleared = false;
      return timerCount;
    },
    clearTimer: () => {
      timerCleared = true;
      timerFn = null;
    },
  };

  return {
    deps,
    calls,
    state,
    timerCount: () => timerCount,
    hasPendingTimer: () => timerFn !== null && !timerCleared,
    /** Manually fire the currently pending timer, as if its delay elapsed. */
    fireTimer: async () => {
      const fn = timerFn;
      if (!fn) throw new Error('expected a pending timer to fire');
      timerFn = null;
      fn();
      // onGraceElapsed is async — let its microtasks (isRunning/restart) settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

console.log('\nonDockConnected() gating rules');

await test('rule: disabled setting skips before any timer is scheduled', () => {
  const { deps, state, timerCount } = fakeDeps({ enabled: false });
  state.paired.add('dock-a');
  const scheduler = new ElgatoAutoRestart(deps);

  scheduler.onDockConnected(0, 'dock-a');

  assert.equal(timerCount(), 0);
});

await test('rule: mock mode skips before any timer is scheduled', () => {
  const { deps, state, timerCount } = fakeDeps({ mock: true });
  state.paired.add('dock-a');
  const scheduler = new ElgatoAutoRestart(deps);

  scheduler.onDockConnected(0, 'dock-a');

  assert.equal(timerCount(), 0);
});

await test('rule: a dock never paired before skips before any timer is scheduled', () => {
  const { deps, timerCount } = fakeDeps();
  const scheduler = new ElgatoAutoRestart(deps);

  scheduler.onDockConnected(0, 'never-paired');

  assert.equal(timerCount(), 0);
});

await test('rule: a qualifying dock starts exactly one shared timer', () => {
  const { deps, state, timerCount } = fakeDeps();
  state.paired.add('dock-a');
  state.paired.add('dock-b');
  const scheduler = new ElgatoAutoRestart(deps);

  scheduler.onDockConnected(0, 'dock-a');
  scheduler.onDockConnected(1, 'dock-b');

  assert.equal(timerCount(), 1, 'a second qualifying dock reuses the one pending timer');
});

console.log('\ngrace-period outcomes');

await test('outcome: every paired dock already attached — restart skipped', async () => {
  const { deps, state, calls, fireTimer } = fakeDeps();
  state.paired.add('dock-a');
  state.attached.add(0);
  const scheduler = new ElgatoAutoRestart(deps);
  scheduler.onDockConnected(0, 'dock-a');

  await fireTimer();

  assert.ok(!calls.includes('restart'), 'restart must not run when the app already attached');
});

await test('outcome: Elgato app conflict — restart skipped', async () => {
  const { deps, state, calls, fireTimer } = fakeDeps();
  state.paired.add('dock-a');
  state.conflict = true;
  const scheduler = new ElgatoAutoRestart(deps);
  scheduler.onDockConnected(0, 'dock-a');

  await fireTimer();

  assert.ok(!calls.includes('restart'), 'restart must not run during a conflict');
});

await test('outcome: Elgato app not running here — restart skipped', async () => {
  const { deps, state, calls, fireTimer } = fakeDeps();
  state.paired.add('dock-a');
  state.running = false;
  const scheduler = new ElgatoAutoRestart(deps);
  scheduler.onDockConnected(0, 'dock-a');

  await fireTimer();

  assert.ok(!calls.includes('restart'), 'restart must not run when the app is not running here');
});

await test('outcome: qualifying dock, no conflict, app running — restart fires', async () => {
  const { deps, state, calls, fireTimer } = fakeDeps();
  state.paired.add('dock-a');
  const scheduler = new ElgatoAutoRestart(deps);
  scheduler.onDockConnected(0, 'dock-a');

  await fireTimer();

  assert.ok(calls.includes('restart'), 'restart should run');
});

console.log('\nonElgatoAttached() early-cancel');

await test('onElgatoAttached cancels the timer once every pending dock is attached', () => {
  const { deps, state, hasPendingTimer } = fakeDeps();
  state.paired.add('dock-a');
  const scheduler = new ElgatoAutoRestart(deps);
  scheduler.onDockConnected(0, 'dock-a');
  assert.ok(hasPendingTimer(), 'timer scheduled after a qualifying connect');

  scheduler.onElgatoAttached(0);

  assert.ok(!hasPendingTimer(), 'timer cancelled once the last pending dock attached');
});

await test('onElgatoAttached for one dock does not cancel the timer while another is pending', () => {
  const { deps, state, hasPendingTimer } = fakeDeps();
  state.paired.add('dock-a');
  state.paired.add('dock-b');
  const scheduler = new ElgatoAutoRestart(deps);
  scheduler.onDockConnected(0, 'dock-a');
  scheduler.onDockConnected(1, 'dock-b');

  scheduler.onElgatoAttached(0);

  assert.ok(hasPendingTimer(), 'dock-b is still pending, so the timer must stay armed');
});

console.log('\nonce-per-process rule');

await test('a restart already fired this process — further connects are skipped, no new timer', async () => {
  const { deps, state, calls, timerCount, fireTimer } = fakeDeps();
  state.paired.add('dock-a');
  state.paired.add('dock-b');
  const scheduler = new ElgatoAutoRestart(deps);
  scheduler.onDockConnected(0, 'dock-a');
  await fireTimer();
  assert.ok(calls.includes('restart'), 'first restart should have fired');

  const timerCountBefore = timerCount();
  scheduler.onDockConnected(1, 'dock-b');

  assert.equal(timerCount(), timerCountBefore, 'no new timer once the feature already fired');
});

console.log('\ndispose()');

await test('dispose() cancels a pending timer', () => {
  const { deps, state, hasPendingTimer } = fakeDeps();
  state.paired.add('dock-a');
  const scheduler = new ElgatoAutoRestart(deps);
  scheduler.onDockConnected(0, 'dock-a');
  assert.ok(hasPendingTimer());

  scheduler.dispose();

  assert.ok(!hasPendingTimer());
});

summary();
