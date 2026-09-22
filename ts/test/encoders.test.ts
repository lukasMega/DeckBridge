import assert from 'tjs:assert';
import { EncoderActions, type EncoderOverride } from '../src/encoders.js';
import { COMMAND_TIMEOUT_DEFAULT_MS } from '../src/types.js';
import type { DialEvent } from '../src/types.js';
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

const COMMANDS = {
  '0': { press: 'echo press0', rotateCw: 'echo cw0', rotateCcw: 'echo ccw0' },
  '2': { press: '  ', rotateCw: 'echo cw2' },
};

const DISCONNECTED: EncoderOverride = {
  mode: 'deckbridge-ignore',
  encoders: { connectToApp: false, commands: COMMANDS },
};

function setup(initial: EncoderOverride = DISCONNECTED) {
  let settings: EncoderOverride | undefined = initial;
  const runner = new FakeRunner();
  const actions = new EncoderActions(() => settings, runner.run);
  return {
    runner,
    actions,
    set: (next: EncoderOverride | undefined) => {
      settings = next;
    },
  };
}

const press = (index: number, state: 'down' | 'up'): DialEvent => ({ index, kind: 'press', state });
const rotate = (index: number, delta: number): DialEvent => ({ index, kind: 'rotate', delta });

await test('press down / CW / CCW run their commands with the default kill timeout', () => {
  const { runner, actions } = setup();
  assert.equal(actions.handleDial(press(0, 'down')), true, 'press consumed');
  assert.equal(actions.handleDial(rotate(0, 1)), true, 'CW consumed');
  assert.equal(actions.handleDial(rotate(0, -1)), true, 'CCW consumed');
  assert.deepEqual(
    runner.runs.map((r) => r.cmd),
    ['echo press0', 'echo cw0', 'echo ccw0'],
  );
  assert.ok(runner.runs.every((r) => r.timeoutMs === COMMAND_TIMEOUT_DEFAULT_MS));
});

await test('press up is consumed without running anything', () => {
  const { runner, actions } = setup();
  assert.equal(actions.handleDial(press(0, 'up')), true);
  assert.equal(runner.runs.length, 0);
});

await test('a disconnected knob with no (or blank) command is still consumed', () => {
  const { runner, actions } = setup();
  assert.equal(actions.handleDial(press(1, 'down')), true, 'no commands for knob 1');
  assert.equal(actions.handleDial(press(2, 'down')), true, 'whitespace-only command');
  assert.equal(actions.handleDial(rotate(2, -1)), true, 'unset rotateCcw');
  assert.equal(runner.runs.length, 0);
});

await test('connectToApp (explicit or default) and missing settings forward to the app', () => {
  const { runner, actions, set } = setup();
  set(undefined);
  assert.equal(actions.handleDial(press(0, 'down')), false, 'no settings');
  set({ mode: 'deckbridge-repaint' });
  assert.equal(actions.handleDial(press(0, 'down')), false, 'no encoder settings');
  set({ mode: 'deckbridge-repaint', encoders: { commands: COMMANDS } });
  assert.equal(actions.handleDial(rotate(0, 1)), false, 'connectToApp defaults to true');
  set({ mode: 'deckbridge-repaint', encoders: { connectToApp: true, commands: COMMANDS } });
  assert.equal(actions.handleDial(rotate(0, 1)), false, 'connectToApp true');
  assert.equal(runner.runs.length, 0);
});

await test("'elgato' strip mode ignores a disconnected encoder config", () => {
  const { runner, actions } = setup({ ...DISCONNECTED, mode: 'elgato' });
  assert.equal(actions.handleDial(press(0, 'down')), false);
  assert.equal(actions.handleDial(rotate(0, 1)), false);
  assert.equal(runner.runs.length, 0);
});

await test('a fast spin coalesces into one follow-up run per (knob, action)', async () => {
  const { runner, actions } = setup();
  for (let i = 0; i < 5; i++) actions.handleDial(rotate(0, 1));
  actions.handleDial(rotate(0, -1)); // a different action has its own slot
  assert.deepEqual(
    runner.runs.map((r) => r.cmd),
    ['echo cw0', 'echo ccw0'],
    'one process per action while inflight',
  );
  await runner.finishNext();
  assert.equal(runner.runs.at(-1)?.cmd, 'echo cw0', 'pending detents re-run once');
  assert.equal(runner.runs.length, 3);
  await runner.finishNext(); // ccw0 — nothing pending
  await runner.finishNext(); // the coalesced cw0 — nothing pending
  assert.equal(runner.runs.length, 3, 'no further runs once drained');
  actions.handleDial(rotate(0, 1));
  assert.equal(runner.runs.length, 4, 'slot free again after the run completes');
});

await test('a failed run frees the slot and still honours a pending re-run', async () => {
  const { runner, actions } = setup();
  actions.handleDial(press(0, 'down'));
  actions.handleDial(press(0, 'down'));
  await runner.finishNext(true);
  assert.equal(runner.runs.length, 2, 'pending re-run after failure');
});

await test('a coalesced re-run is dropped when the knob was reconnected meanwhile', async () => {
  const { runner, actions, set } = setup();
  actions.handleDial(rotate(0, 1));
  actions.handleDial(rotate(0, 1));
  set({ mode: 'deckbridge-ignore', encoders: { connectToApp: true, commands: COMMANDS } });
  await runner.finishNext();
  assert.equal(runner.runs.length, 1);
});

summary();
