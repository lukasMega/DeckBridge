import assert from 'tjs:assert';
import { createElgatoAppControl } from '../src/infra/elgato-app.js';
import { testAsync as test, summary } from './helpers/harness.js';

/** In-memory fake of the injected deps. `state.running` models the fake
 *  process; `hooks.onSpawn`/`onOpenUrl` are mutable so a test can flip
 *  `state.running` from inside a spawn/openUrl call to simulate a quit/kill/
 *  launch actually taking effect. `calls` records every invocation for
 *  assertions. `sleep` never really waits — `pollUntil`'s deadline is still
 *  real `Date.now()`, so tests pass small `quitTimeoutMs`/`relaunchDelayMs`
 *  overrides (or rely on a platform with no fixed internal wait) to stay fast. */
function fakeDeps(opts: { platform?: string; running?: boolean } = {}) {
  const calls: string[] = [];
  const state = { running: opts.running ?? true };
  const hooks: { onSpawn?: (args: string[]) => void; onOpenUrl?: (url: string) => void } = {};
  const deps = {
    platform: () => opts.platform ?? 'macOS',
    isRunning: () => Promise.resolve(state.running),
    openUrl: (url: string) => {
      calls.push(`openUrl:${url}`);
      hooks.onOpenUrl?.(url);
      return Promise.resolve();
    },
    spawn: ((args: string[]) => {
      calls.push(`spawn:${args.join(' ')}`);
      hooks.onSpawn?.(args);
      return {} as TjsProcess;
    }) as typeof tjs.spawn,
    sleep: async () => {},
  };
  return { deps, calls, state, hooks };
}

console.log('\nrestart()');

await test('deeplink quit succeeds, then launch is verified — killed: false', async () => {
  const { deps, calls, state, hooks } = fakeDeps();
  hooks.onOpenUrl = (url) => {
    if (url === 'streamdeck://app/quit') state.running = false;
  };
  hooks.onSpawn = (args) => {
    if (args.join(' ').startsWith('open -g -a')) state.running = true;
  };

  const control = createElgatoAppControl(deps);
  const result = await control.restart({ quitTimeoutMs: 50, relaunchDelayMs: 1 });

  assert.ok(result.ok, `expected ok result, got ${JSON.stringify(result)}`);
  if (result.ok) assert.equal(result.killed, false);
  assert.ok(calls.includes('openUrl:streamdeck://app/quit'));
  assert.ok(
    calls.some((c) => c.startsWith('spawn:open -g -a')),
    'launch command was spawned',
  );
});

await test('deeplink quit times out, kill fallback succeeds', async () => {
  const { deps, calls, state, hooks } = fakeDeps();
  // openUrl (the deeplink) never changes `state.running` in this test, so the
  // quit-timeout path is exercised; only the pkill fallback kills the app.
  hooks.onSpawn = (args) => {
    const joined = args.join(' ');
    if (joined.startsWith('pkill')) state.running = false;
    else if (joined.startsWith('open -g -a')) state.running = true;
  };

  const control = createElgatoAppControl(deps);
  const result = await control.restart({ quitTimeoutMs: 20, relaunchDelayMs: 1 });

  assert.ok(result.ok, `expected ok result, got ${JSON.stringify(result)}`);
  if (result.ok) assert.equal(result.killed, true);
  assert.ok(
    calls.some((c) => c.startsWith('spawn:pkill')),
    'pkill was attempted',
  );
});

await test('kill fallback fails to stop the app — still-running, no launch attempted', async () => {
  const { deps, calls } = fakeDeps();
  // No hook ever flips `state.running` — the app survives every kill attempt.

  const control = createElgatoAppControl(deps);
  const result = await control.restart({ quitTimeoutMs: 20, relaunchDelayMs: 1 });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'still-running');
  assert.ok(
    !calls.some((c) => c.startsWith('spawn:open')),
    'must not attempt to launch when the old process never died',
  );
});

console.log('\nlaunch()');

await test('primary launch command fails to spawn — falls back to the second command', async () => {
  const { deps, calls, state, hooks } = fakeDeps({ running: false });
  hooks.onSpawn = (args) => {
    const joined = args.join(' ');
    if (joined.startsWith('open -g -a')) throw new Error('binary not found');
    if (joined.startsWith('open -g streamdeck://')) state.running = true;
  };

  const control = createElgatoAppControl(deps);
  const ok = await control.launch();

  assert.equal(ok, true);
  assert.ok(
    calls.some((c) => c.startsWith('spawn:open -g -a')),
    'primary attempt was tried',
  );
  assert.ok(
    calls.some((c) => c.startsWith('spawn:open -g streamdeck://')),
    'fallback was tried',
  );
});

await test('launch fails outright when every attempt throws', async () => {
  const { deps } = fakeDeps({ running: false });
  deps.spawn = () => {
    throw new Error('nope');
  };
  deps.openUrl = () => {
    throw new Error('nope');
  };

  const control = createElgatoAppControl(deps);
  assert.equal(await control.launch(), false);
});

console.log('\nunsupported platform / not-running');

await test('restart() on an unsupported platform is a no-op', async () => {
  const { deps } = fakeDeps({ platform: 'Linux', running: true });
  const control = createElgatoAppControl(deps);
  const result = await control.restart();
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'unsupported-platform');
});

await test('launch() on an unsupported platform is a no-op', async () => {
  const { deps } = fakeDeps({ platform: 'Linux' });
  const control = createElgatoAppControl(deps);
  assert.equal(await control.launch(), false);
});

await test('restart() when the app is not running is a no-op', async () => {
  const { deps } = fakeDeps({ platform: 'macOS', running: false });
  const control = createElgatoAppControl(deps);
  const result = await control.restart();
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'not-running');
});

console.log('\nconcurrency');

await test('concurrent restart() calls share one in-flight promise', async () => {
  const { deps, state, hooks } = fakeDeps();
  let quitCalls = 0;
  hooks.onOpenUrl = (url) => {
    if (url === 'streamdeck://app/quit') {
      quitCalls++;
      state.running = false;
    }
  };
  hooks.onSpawn = (args) => {
    if (args.join(' ').startsWith('open -g -a')) state.running = true;
  };

  const control = createElgatoAppControl(deps);
  const [a, b] = await Promise.all([
    control.restart({ quitTimeoutMs: 50, relaunchDelayMs: 1 }),
    control.restart({ quitTimeoutMs: 50, relaunchDelayMs: 1 }),
  ]);

  assert.equal(a, b, 'both callers observe the identical result object');
  assert.equal(quitCalls, 1, 'the deeplink quit ran exactly once, not twice');
});

await test('a restart() after the previous one settled starts a fresh one', async () => {
  const { deps, state, hooks } = fakeDeps();
  let quitCalls = 0;
  hooks.onOpenUrl = (url) => {
    if (url === 'streamdeck://app/quit') {
      quitCalls++;
      state.running = false;
    }
  };
  hooks.onSpawn = (args) => {
    if (args.join(' ').startsWith('open -g -a')) state.running = true;
  };

  const control = createElgatoAppControl(deps);
  await control.restart({ quitTimeoutMs: 50, relaunchDelayMs: 1 });
  await control.restart({ quitTimeoutMs: 50, relaunchDelayMs: 1 });

  assert.equal(quitCalls, 2, 'a settled restart does not stay cached');
});

console.log('\nisRunning()');

await test('isRunning() forwards to the injected probe', async () => {
  const { deps, state } = fakeDeps({ running: true });
  const control = createElgatoAppControl(deps);
  assert.equal(await control.isRunning(), true);
  state.running = false;
  assert.equal(await control.isRunning(), false);
});

await test('cancelLaunches: a restart past its quit step does not relaunch', async () => {
  const { deps, calls, state, hooks } = fakeDeps();
  hooks.onOpenUrl = (url) => {
    if (url === 'streamdeck://app/quit') state.running = false;
  };
  const control = createElgatoAppControl({
    ...deps,
    // DeckBridge starts quitting during the relaunch delay.
    sleep: () => {
      control.cancelLaunches();
      return Promise.resolve();
    },
  });
  const result = await control.restart({ quitTimeoutMs: 50, relaunchDelayMs: 1 });
  assert.deepEqual(result, { ok: false, reason: 'cancelled' });
  assert.ok(!calls.some((c) => c.startsWith('spawn:open')), 'no launch spawned');
  assert.equal(await control.launch(), false, 'later launches refused');
});

summary();
