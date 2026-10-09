import assert from 'tjs:assert';
import {
  startTray,
  buildTrayState,
  parentDir,
  isAbsolutePath,
  resolveTrayBin,
  serializeTrayState,
} from '../src/infra/tray.js';
import { platformName } from '../src/infra/os-utils.js';
import { test, testAsync as asyncTest, summary } from './helpers/harness.js';

// parentDir

console.log('\nparentDir');

test('Unix path → parent directory', () => {
  assert.equal(parentDir('/usr/local/bin/tray'), '/usr/local/bin');
});

test('single-segment Unix path → parent directory', () => {
  assert.equal(parentDir('/usr/tray'), '/usr');
});

test('Windows path → parent directory', () => {
  assert.equal(parentDir('C:\\Users\\user\\tray.exe'), 'C:\\Users\\user');
});

test('no separator → dot', () => {
  assert.equal(parentDir('tray'), '.');
});

test('root-only slash → dot (i = 0, not > 0)', () => {
  assert.equal(parentDir('/tray'), '.');
});

// isAbsolutePath

console.log('\nisAbsolutePath');

test('Unix absolute path → true', () => {
  assert.ok(isAbsolutePath('/usr/local/bin/tray'));
});

test('Windows absolute path (uppercase drive) → true', () => {
  assert.ok(isAbsolutePath('C:\\Users\\tray.exe'));
});

test('Windows absolute path (lowercase drive) → true', () => {
  assert.ok(isAbsolutePath('c:/Users/tray.exe'));
});

test('Windows absolute path (mixed case) → true', () => {
  assert.ok(isAbsolutePath('Z:\\tray.exe'));
});

test('relative path → false', () => {
  assert.ok(!isAbsolutePath('tray'));
});

test('relative path with directory → false', () => {
  assert.ok(!isAbsolutePath('go/tray-go'));
});

test('drive letter without colon → false', () => {
  assert.ok(!isAbsolutePath('Ctray.exe'));
});

// Tray state serialization

console.log('\nTray state serialization');

test('updateAvailable round-trips through TCP JSON', () => {
  const line = serializeTrayState({
    icon: 'full',
    status: 'Connected',
    reconnectAttempts: 0,
    updateAvailable: true,
    updateText: 'Update available: v1.2.3',
    version: '1.2.3',
  });
  const state = JSON.parse(line) as { updateAvailable: boolean; updateText: string };
  assert.equal(state.updateAvailable, true);
  assert.equal(state.updateText, 'Update available: v1.2.3');
});

test('notify rides on a normal state line; absent when not given', () => {
  const state = {
    icon: 'full' as const,
    status: 'Connected',
    reconnectAttempts: 0,
    updateAvailable: false,
    updateText: 'x',
    version: '1.2.3',
  };
  const notify = { title: 'DeckBridge', body: 'b', url: 'http://localhost:3000/?survey=1' };
  assert.equal(serializeTrayState(state).includes('notify'), false);
  const line = serializeTrayState(state, notify);
  assert.ok(line.endsWith('\n'));
  const parsed = JSON.parse(line) as typeof state & { notify: typeof notify };
  assert.equal(parsed.notify, notify);
  assert.equal(parsed.status, 'Connected');
});

// TrayProcess.close() kills the spawned process (L1)
// TrayProcess.proc is private and not directly reachable from a test without a
// real tray-go binary, so this exercises the same TjsProcess.kill('SIGTERM')
// call that TrayProcess.close() now makes on a trivial long-running child, to
// verify the API behaves as close() relies on (process stops after SIGTERM).

console.log('\nTrayProcess.close() process termination (L1)');

await asyncTest('SIGTERM stops a spawned child process', async () => {
  const proc = tjs.spawn(['cat'], { stdout: 'ignore', stderr: 'ignore' });
  proc.kill('SIGTERM');
  const { exit_status, term_signal } = await proc.wait();
  // 'cat' with no explicit handler dies on SIGTERM: either a non-zero exit
  // status or a recorded term_signal, depending on platform reporting.
  assert.ok(exit_status !== 0 || term_signal !== null);
});

// resolveTrayBin
// Regression guard: /requirements used to read $DECKBRIDGE_TRAY_BIN only, so a
// packaged release (which ships the tray as a sidecar next to the executable)
// reported "Not found" while the tray was running.

console.log('\nresolveTrayBin');

await asyncTest('prefers $DECKBRIDGE_TRAY_BIN when set', async () => {
  const prev = tjs.env.DECKBRIDGE_TRAY_BIN;
  tjs.env.DECKBRIDGE_TRAY_BIN = '/some/explicit/deckbridge-tray';
  try {
    assert.equal(await resolveTrayBin(), '/some/explicit/deckbridge-tray');
  } finally {
    if (prev === undefined) delete tjs.env.DECKBRIDGE_TRAY_BIN;
    else tjs.env.DECKBRIDGE_TRAY_BIN = prev;
  }
});

await asyncTest('returns "" when the env var is unset and no sidecar exists', async () => {
  const prev = tjs.env.DECKBRIDGE_TRAY_BIN;
  delete tjs.env.DECKBRIDGE_TRAY_BIN;
  try {
    // tjs.exePath here is the test runner's tjs binary — no deckbridge-tray beside it.
    assert.equal(await resolveTrayBin(), '');
  } finally {
    if (prev !== undefined) tjs.env.DECKBRIDGE_TRAY_BIN = prev;
  }
});

// buildTrayState

console.log('\nbuildTrayState');

const LATEST = { enabled: true, current: '1.0.0', updateAvailable: false, lastCheckedAt: 1 };
const trayInput = {
  deviceName: 'Mirabox 293S',
  driverConnected: true,
  elgatoConnected: true,
  reconnectAttempts: 0,
  update: LATEST,
};

test('device + Elgato app → full icon', () => {
  const s = buildTrayState(trayInput);
  assert.equal(s.icon, 'full');
  assert.equal(s.status, 'Mirabox 293S + Elgato app connected');
  assert.equal(s.updateText, 'Using latest version');
});

test('no device → attempt count in status', () => {
  const s = buildTrayState({ ...trayInput, driverConnected: false, reconnectAttempts: 3 });
  assert.equal(s.icon, 'disconnected');
  assert.equal(s.status, 'No device (attempt 3)');
});

test('dismissed update is not flagged', () => {
  const update = { ...LATEST, updateAvailable: true, latest: '1.1.0', dismissedVersion: '1.1.0' };
  const s = buildTrayState({ ...trayInput, update });
  assert.equal(s.updateText, 'Update available: v1.1.0');
  assert.equal(s.updateAvailable, false);
});

console.log('\nstartTray().close()');

// The fixtures below are POSIX shell scripts.
const posix = platformName() !== 'Windows';

const trayStateWithAttempts = (n: number) =>
  buildTrayState({
    deviceName: 'D',
    driverConnected: true,
    elgatoConnected: false,
    reconnectAttempts: n,
    update: { enabled: false, updateAvailable: false } as never,
  });

if (posix) {
  await asyncTest('push coalesces to the newest snapshot while a write is in flight', async () => {
    const received: string[] = [];
    const server = await tjs.listen('tcp', '127.0.0.1', 0);
    const info = await server.opened;
    const port = info.localPort;
    const accept = (async (): Promise<void> => {
      const r = info.readable.getReader();
      const { value: conn } = await r.read();
      r.releaseLock();
      const cinfo = await conn!.opened;
      const rd = cinfo.readable.getReader();
      let acc = '';
      for (;;) {
        const { value, done } = await rd.read();
        if (done) break;
        acc += new TextDecoder().decode(value);
        const lines = acc.split('\n');
        acc = lines.pop() ?? '';
        received.push(...lines);
      }
    })();
    const script = `${tjs.tmpDir}/fake-tray-co-${tjs.pid}.sh`;
    await tjs.writeFile(
      script,
      `#!/bin/sh\necho '{"event":"ready","port":${port}}'\nwhile :; do sleep 0.05; done\n`,
    );
    await tjs.spawn(['chmod', '+x', script]).wait();
    let tray: ReturnType<typeof startTray> = null;
    try {
      tray = startTray(script, { onQuit: () => {}, onRestartElgatoApp: () => {} });
      assert.ok(tray, 'spawned');
      // Let the tray connect, then burst while the first write is in flight.
      await new Promise((r) => setTimeout(r, 400));
      tray!.push(trayStateWithAttempts(0));
      for (let i = 1; i <= 50; i++) tray!.push(trayStateWithAttempts(i));
      await new Promise((r) => setTimeout(r, 300));
      assert.ok(received.length >= 1 && received.length <= 2, `writes: ${received.length}`);
      assert.equal(
        (JSON.parse(received[received.length - 1]!) as { reconnectAttempts: number })
          .reconnectAttempts,
        50,
      );
    } finally {
      await tray?.close();
      server.close();
      await accept.catch(() => undefined);
      await tjs.remove(script).catch(() => undefined);
    }
  });

  await asyncTest(
    'close escalates to SIGKILL for a sidecar ignoring SIGTERM and observes its exit',
    async () => {
      const script = `${tjs.tmpDir}/fake-tray-${tjs.pid}.sh`;
      const pidFile = `${script}.pid`;
      await tjs.writeFile(
        script,
        `#!/bin/sh\necho $$ > ${pidFile}\ntrap '' TERM\nwhile :; do sleep 0.05; done\n`,
      );
      await tjs.spawn(['chmod', '+x', script]).wait();
      // Outside the try so a failing startup assertion still closes the sidecar.
      let tray: ReturnType<typeof startTray> = null;
      try {
        tray = startTray(script, { onQuit: () => {}, onRestartElgatoApp: () => {} });
        assert.ok(tray, 'spawned');
        let pid = 0;
        for (let i = 0; i < 40 && !pid; i++) {
          await new Promise((r) => setTimeout(r, 25));
          const raw = await tjs.readFile(pidFile).catch(() => new Uint8Array());
          pid = Number(new TextDecoder().decode(raw).trim());
        }
        assert.ok(pid > 0, 'sidecar started');
        const t0 = Date.now();
        await tray!.close();
        tray = null;
        assert.ok(Date.now() - t0 < 1500, 'bounded');
        const probe = await tjs.spawn(['kill', '-0', String(pid)], { stderr: 'ignore' }).wait();
        assert.notEqual(probe.exit_status, 0, 'sidecar gone');
      } finally {
        await tray?.close();
        await tjs.remove(script).catch(() => undefined);
        await tjs.remove(pidFile).catch(() => undefined);
      }
    },
  );
}

// Summary

summary();
