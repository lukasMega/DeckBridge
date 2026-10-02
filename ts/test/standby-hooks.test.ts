import assert from 'tjs:assert';
import { createStandbyHooks, STANDBY_COMMAND_TIMEOUT_MS } from '../src/main/standby-hooks.js';
import { DEFAULT_STANDBY } from '../src/shared/standby-settings.js';
import type { StandbySettings } from '../src/shared/types.js';
import { testAsync as test, summary } from './helpers/harness.js';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function setup(extra: Partial<StandbySettings>, run: (cmd: string, ms: number) => Promise<string>) {
  const settings: StandbySettings = { ...DEFAULT_STANDBY, ...extra };
  return createStandbyHooks(2, () => settings, run);
}

console.log('\nstandby hooks');

await test('runs the matching command with the 10 s timeout', async () => {
  const calls: Array<[string, number]> = [];
  const hook = setup({ sleepCommand: 'off.sh', wakeCommand: 'on.sh' }, (c, ms) => {
    calls.push([c, ms]);
    return Promise.resolve('');
  });
  hook('sleep');
  hook('wake');
  await flush();
  assert.deepEqual(calls, [
    ['off.sh', STANDBY_COMMAND_TIMEOUT_MS],
    ['on.sh', STANDBY_COMMAND_TIMEOUT_MS],
  ]);
});

await test('no-op when the command is unset', async () => {
  let n = 0;
  const hook = setup({ wakeCommand: 'on.sh' }, () => {
    n++;
    return Promise.resolve('');
  });
  hook('sleep');
  await flush();
  assert.equal(n, 0);
});

await test('skips a kind while its previous run is in flight, then allows it again', async () => {
  const gate: { release: () => void } = { release: () => undefined };
  let n = 0;
  const hook = setup({ wakeCommand: 'on.sh' }, () => {
    n++;
    return new Promise<string>((r) => {
      gate.release = () => r('');
    });
  });
  hook('wake');
  hook('wake');
  assert.equal(n, 1);
  gate.release();
  await flush();
  hook('wake');
  assert.equal(n, 2);
});

await test('a rejected or throwing run does not escape and frees the slot', async () => {
  let n = 0;
  const hook = setup({ sleepCommand: 'x' }, () => {
    n++;
    if (n === 1) return Promise.reject(new Error('boom'));
    throw new Error('sync boom');
  });
  hook('sleep');
  await flush();
  hook('sleep');
  await flush();
  hook('sleep');
  assert.equal(n, 3);
});

summary();
