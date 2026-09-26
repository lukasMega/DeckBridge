import assert from 'tjs:assert';
import { ExtraKeyActions } from '../src/command-actions.js';
import {
  COMMAND_TIMEOUT_DEFAULT_MS,
  effectivePressAction,
  isExtraKeyConfig,
} from '../src/types.js';
import type { ExtraKeyConfig } from '../src/types.js';
import { testAsync as test, summary } from './helpers/harness.js';

/** Records each run and holds it open until the test settles it. */
class FakeRunner {
  readonly runs: { cmd: string; timeoutMs: number }[] = [];
  private readonly pending: PromiseWithResolvers<string>[] = [];
  readonly run = (cmd: string, timeoutMs: number): Promise<string> => {
    this.runs.push({ cmd, timeoutMs });
    const deferred = Promise.withResolvers<string>();
    this.pending.push(deferred);
    return deferred.promise;
  };
  /** Settle the oldest open run, then let its finally() chain drain. */
  async finishNext(fail = false): Promise<void> {
    const deferred = this.pending.shift();
    if (fail) deferred?.reject(new Error('spawn failed'));
    else deferred?.resolve('');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function setup(initial: Record<number, ExtraKeyConfig>) {
  let configs = initial;
  const runner = new FakeRunner();
  const refreshed: number[] = [];
  const actions = new ExtraKeyActions(
    (wireId) => configs[wireId],
    runner.run,
    (wireId) => refreshed.push(wireId),
  );
  return {
    runner,
    actions,
    refreshed,
    set: (next: Record<number, ExtraKeyConfig>) => {
      configs = next;
    },
  };
}

await test('press down runs the trimmed command with the default kill timeout; up does not', () => {
  const { runner, actions } = setup({ 15: { widget: 'clock', pressCommand: ' open -a Music ' } });
  actions.handleKey(15, 'down');
  actions.handleKey(15, 'up');
  assert.deepEqual(runner.runs, [{ cmd: 'open -a Music', timeoutMs: COMMAND_TIMEOUT_DEFAULT_MS }]);
});

await test('no config, no command, or a blank command runs nothing (it refreshes instead)', () => {
  const { runner, actions, refreshed } = setup({
    10: { widget: 'clock' },
    15: { widget: 'none', pressCommand: '  ' },
  });
  actions.handleKey(10, 'down');
  actions.handleKey(15, 'down');
  actions.handleKey(3, 'down');
  assert.equal(runner.runs.length, 0);
  assert.deepEqual(refreshed, [10, 15, 3], 'default without a command: refresh');
});

await test('pressAction: command / refresh / both; unset with a command keeps the command', () => {
  const { runner, actions, refreshed } = setup({
    1: { widget: 'clock', pressCommand: 'a' },
    2: { widget: 'clock', pressCommand: 'b', pressAction: 'refresh' },
    3: { widget: 'clock', pressCommand: 'c', pressAction: 'both' },
    4: { widget: 'clock', pressCommand: 'd', pressAction: 'command' },
    5: { widget: 'clock', pressAction: 'command' },
  });
  for (const wireId of [1, 2, 3, 4, 5]) actions.handleKey(wireId, 'down');
  assert.deepEqual(
    runner.runs.map((r) => r.cmd),
    ['a', 'c', 'd'],
  );
  assert.deepEqual(refreshed, [2, 3], "'command' with no command does nothing");
});

await test('effectivePressAction defaults + isExtraKeyConfig pressAction guard', () => {
  assert.equal(effectivePressAction(undefined), 'refresh');
  assert.equal(effectivePressAction({ widget: 'clock' }), 'refresh');
  assert.equal(effectivePressAction({ widget: 'clock', pressCommand: '  ' }), 'refresh');
  assert.equal(effectivePressAction({ widget: 'clock', pressCommand: 'x' }), 'command');
  assert.equal(effectivePressAction({ widget: 'clock', pressAction: 'both' }), 'both');
  for (const pressAction of ['refresh', 'command', 'both']) {
    assert.ok(isExtraKeyConfig({ widget: 'none', pressAction }), pressAction);
  }
  for (const pressAction of ['run', '', 1, null, true]) {
    assert.ok(!isExtraKeyConfig({ widget: 'none', pressAction }), String(pressAction));
  }
});

await test('presses while running coalesce into one re-run with the current command', async () => {
  const { runner, actions, set } = setup({ 15: { widget: 'none', pressCommand: 'a' } });
  actions.handleKey(15, 'down');
  actions.handleKey(15, 'down');
  actions.handleKey(15, 'down');
  assert.equal(runner.runs.length, 1, 'one process while the first runs');
  set({ 15: { widget: 'none', pressCommand: 'b' } });
  await runner.finishNext(true);
  assert.deepEqual(
    runner.runs.map((r) => r.cmd),
    ['a', 'b'],
    'a failed run still frees the slot; the re-run re-resolves the command',
  );
  await runner.finishNext();
  actions.handleKey(15, 'down');
  assert.equal(runner.runs.length, 3, 'slot free again');
});

summary();
