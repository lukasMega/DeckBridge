import assert from 'tjs:assert';
import { ExtraKeyActions } from '../src/command-actions.js';
import { COMMAND_TIMEOUT_DEFAULT_MS } from '../src/types.js';
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
  const actions = new ExtraKeyActions((wireId) => configs[wireId], runner.run);
  return {
    runner,
    actions,
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

await test('no config, no command, or a blank command runs nothing', () => {
  const { runner, actions } = setup({
    10: { widget: 'clock' },
    15: { widget: 'none', pressCommand: '  ' },
  });
  actions.handleKey(10, 'down');
  actions.handleKey(15, 'down');
  actions.handleKey(3, 'down');
  assert.equal(runner.runs.length, 0);
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
