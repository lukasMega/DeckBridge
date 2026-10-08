import assert from 'tjs:assert';
import { ElgatoAutoRestart } from '../src/main/elgato-auto-restart.js';
import type { AutoRestartPending, ElgatoAutoRestartDeps } from '../src/main/elgato-auto-restart.js';
import type { RestartResult } from '../src/infra/elgato-app.js';
import { testAsync as test, summary } from './helpers/harness.js';

/** In-memory fake of every injected dep, plus a manually-fired timer (no real
 *  setTimeout — the design has at most one shared timer live at a time, so
 *  tracking a single pending callback is enough to drive every test). */
/** Let the async app-running check (and anything it chains) settle. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function fakeDeps(overrides: { enabled?: boolean; delayS?: number; mock?: boolean } = {}) {
  const calls: string[] = [];
  const progress: Array<AutoRestartPending | null> = [];
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
    onPending: (pending) => progress.push(pending),
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
    progress,
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

await test('progress keeps one deadline until failed restart finishes', async () => {
  const { deps, state, progress, fireTimer } = fakeDeps({ delayS: 4 });
  state.paired.add('dock-a');
  state.paired.add('dock-b');
  let finishRestart!: (result: RestartResult) => void;
  deps.app.restart = () =>
    new Promise((resolve) => {
      finishRestart = resolve;
    });
  const scheduler = new ElgatoAutoRestart(deps);
  const started = Date.now();
  scheduler.onDockConnected(0, 'dock-a');
  await settle();
  scheduler.onDockConnected(1, 'dock-b');
  assert.equal(progress.length, 2, 'initial publish + one re-publish when dock 1 joins');
  const first = progress[0]!;
  assert.ok(first.at >= started + 4000 && first.at <= Date.now() + 4000);
  assert.equal(progress[1]!.at, first.at, 'a joining dock keeps the same deadline');
  await fireTimer();
  assert.equal(progress.length, 2, 'controls remain locked during the restart');
  finishRestart({ ok: false, reason: 'launch-failed' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(progress.at(-1), null, 'failure unlocks controls');
});

await test('pending docks: a later-joining dock is added; repeats do not re-publish', async () => {
  const { deps, state, progress } = fakeDeps();
  state.paired.add('dock-a');
  state.paired.add('dock-b');
  const scheduler = new ElgatoAutoRestart(deps);
  scheduler.onDockConnected(0, 'dock-a');
  await settle();
  assert.deepEqual(progress.at(-1)!.docks, [0]);
  scheduler.onDockConnected(1, 'dock-b');
  assert.deepEqual(progress.at(-1)!.docks, [0, 1]);
  const count = progress.length;
  scheduler.onDockConnected(1, 'dock-b');
  assert.equal(progress.length, count, 'same dock again is not a new publish');
});

await test('pending docks: a never-paired dock is never included', async () => {
  const { deps, state, progress } = fakeDeps();
  state.paired.add('dock-a');
  const scheduler = new ElgatoAutoRestart(deps);
  scheduler.onDockConnected(0, 'dock-a');
  scheduler.onDockConnected(1, 'dock-new');
  await settle();
  assert.deepEqual(progress.at(-1)!.docks, [0]);
});

await test('app not running at connect — no countdown published, timer dropped', async () => {
  const { deps, state, calls, progress, hasPendingTimer } = fakeDeps();
  state.paired.add('dock-a');
  state.paired.add('dock-b');
  state.running = false;
  const scheduler = new ElgatoAutoRestart(deps);
  scheduler.onDockConnected(0, 'dock-a');
  scheduler.onDockConnected(1, 'dock-b');
  await settle();

  assert.equal(progress.length, 0, 'the pairing controls stay available');
  assert.ok(!hasPendingTimer(), 'the round is dropped');
  assert.ok(!calls.includes('restart'));
});

await test('app-running check fails — countdown still published', async () => {
  const { deps, state, progress } = fakeDeps();
  state.paired.add('dock-a');
  deps.app.isRunning = () => Promise.reject(new Error('spawn failed'));
  const scheduler = new ElgatoAutoRestart(deps);
  scheduler.onDockConnected(0, 'dock-a');
  await settle();

  assert.deepEqual(progress.at(-1)!.docks, [0]);
});

await test('outcome: every paired dock already attached — restart skipped', async () => {
  const { deps, state, calls, progress, fireTimer } = fakeDeps();
  state.paired.add('dock-a');
  state.attached.add(0);
  const scheduler = new ElgatoAutoRestart(deps);
  scheduler.onDockConnected(0, 'dock-a');

  await fireTimer();

  assert.ok(!calls.includes('restart'), 'restart must not run when the app already attached');
  assert.equal(progress.at(-1), null, 'skipping unlocks controls');
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

await test('outcome: Elgato app quit during the grace period — restart skipped', async () => {
  const { deps, state, calls, fireTimer } = fakeDeps();
  state.paired.add('dock-a');
  const scheduler = new ElgatoAutoRestart(deps);
  scheduler.onDockConnected(0, 'dock-a');
  await settle();
  state.running = false;

  await fireTimer();

  assert.ok(!calls.includes('restart'), 'restart must not run when the app is not running here');
});

await test('outcome: qualifying dock, no conflict, app running — restart fires', async () => {
  const { deps, state, calls, progress, fireTimer } = fakeDeps();
  state.paired.add('dock-a');
  const scheduler = new ElgatoAutoRestart(deps);
  scheduler.onDockConnected(0, 'dock-a');

  await fireTimer();

  assert.ok(calls.includes('restart'), 'restart should run');
  assert.equal(progress.at(-1), null, 'completion unlocks controls');
});

console.log('\nonElgatoAttached() defers to the grace-end check');

await test('onElgatoAttached does not cancel the timer', () => {
  const { deps, state, hasPendingTimer } = fakeDeps();
  state.paired.add('dock-a');
  const scheduler = new ElgatoAutoRestart(deps);
  scheduler.onDockConnected(0, 'dock-a');
  assert.ok(hasPendingTimer(), 'timer scheduled after a qualifying connect');

  scheduler.onElgatoAttached(0);

  assert.ok(hasPendingTimer(), 'timer stays armed; the grace-end check decides');
});

await test('an attach that drops before the grace period ends still restarts', async () => {
  const { deps, state, calls, fireTimer } = fakeDeps();
  state.paired.add('dock-a');
  const scheduler = new ElgatoAutoRestart(deps);
  scheduler.onDockConnected(0, 'dock-a');

  // clientConnected fires, then the socket resets (ECONNRESET) — not attached anymore.
  state.attached.add(0);
  scheduler.onElgatoAttached(0);
  state.attached.delete(0);
  await fireTimer();

  assert.ok(calls.includes('restart'), 'a short-lived attach must not suppress the restart');
});

await test('an attach that lasts to the grace end skips the restart', async () => {
  const { deps, state, calls, fireTimer } = fakeDeps();
  state.paired.add('dock-a');
  const scheduler = new ElgatoAutoRestart(deps);
  scheduler.onDockConnected(0, 'dock-a');

  state.attached.add(0);
  scheduler.onElgatoAttached(0);
  await fireTimer();

  assert.ok(!calls.includes('restart'), 'restart must not run while the app stays attached');
});

await test('one dock attached, another still waiting — restart fires', async () => {
  const { deps, state, calls, fireTimer } = fakeDeps();
  state.paired.add('dock-a');
  state.paired.add('dock-b');
  const scheduler = new ElgatoAutoRestart(deps);
  scheduler.onDockConnected(0, 'dock-a');
  scheduler.onDockConnected(1, 'dock-b');

  state.attached.add(0);
  scheduler.onElgatoAttached(0);
  await fireTimer();

  assert.ok(calls.includes('restart'), 'dock-b never attached, so the restart covers it');
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
  const { deps, state, hasPendingTimer, progress } = fakeDeps();
  state.paired.add('dock-a');
  const scheduler = new ElgatoAutoRestart(deps);
  scheduler.onDockConnected(0, 'dock-a');
  assert.ok(hasPendingTimer());

  scheduler.dispose();

  assert.ok(!hasPendingTimer());
  assert.equal(progress.at(-1), null, 'shutdown clears pending progress');
});

summary();
