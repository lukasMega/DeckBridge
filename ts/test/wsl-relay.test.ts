/* eslint-disable sonarjs/no-hardcoded-ip, @typescript-eslint/require-await -- fixture addresses, nothing is contacted; fake runner methods are async to match the interface */
import assert from 'tjs:assert';
import { WslRelay } from '../src/infra/wsl-relay.js';
import type { WslRelayDeps, WslRunner, WslSpawned } from '../src/infra/wsl-relay.js';
import { createMockWslRunner } from '../src/infra/wsl-relay-mock.js';
import { firewallFixCommand, noWslFix, zipName } from '../src/infra/wsl-relay-parse.js';
import type { LogLevel } from '../src/shared/logger.js';
import type { WslRelayStatus } from '../src/web/contract-wsl-relay.js';
import { testAsync as test, summaryExit } from './helpers/harness.js';

const WSL_IP = '172.28.16.5';
const HASH = 'c'.repeat(64);
const DETECT_OK = [
  'kernel=5.15.153.1-microsoft-standard-WSL2',
  'arch=x86_64',
  'glibc=glibc 2.39',
  `ip=${WSL_IP}`,
  'mode=nat',
  'distro=Ubuntu-24.04',
].join('\n');
const ZIP = zipName('9.9.9', 'x86_64');

const stamp = (lvl: string, msg: string): string => `10:00:00.000 ${lvl} [relay] ${msg}`;
const L_WAIT = stamp('WARN ', 'waiting for DeckBridge at 192.168.1.20:5343: connect ECONNREFUSED');
const L_DOCK = stamp('INFO ', 'dock: sn=A7F pid=0x00a5 child port 5344');
const L_LISTEN = stamp('INFO ', 'listening on 0.0.0.0:5343 and :5344');

interface FakeSpawn extends WslSpawned {
  args: string[];
  stopped: boolean;
  emit(line: string): void;
  exit(code: number | null): void;
}

class FakeRunner implements WslRunner {
  detect: { code: number; stdout: string; timedOut?: boolean } | Error = {
    code: 0,
    stdout: DETECT_OK,
  };
  cached = false;
  unzipped = false;
  sums: string = `${HASH}  ${ZIP}\n`;
  sha = HASH;
  downloadError: Error | null = null;
  calls: string[] = [];
  spawns: FakeSpawn[] = [];
  unzipArgs: string[] = [];
  promoted: string[] = [];
  detectTimeouts: number[] = [];
  pkillTimeouts: number[] = [];
  /** Holds every download until released, to overlap flows. */
  gate: Promise<void> | null = null;
  active = 0;
  maxActive = 0;

  async exec(
    args: string[],
    timeoutMs: number,
  ): Promise<{ code: number; stdout: string; timedOut?: boolean }> {
    this.calls.push(`exec ${args.join(' ')}`);
    if (args[0] === 'sh') this.detectTimeouts.push(timeoutMs);
    if (args[0] === 'pkill') this.pkillTimeouts.push(timeoutMs);
    if (args[0] === 'sh') {
      if (this.detect instanceof Error) throw this.detect;
      return this.detect;
    }
    return { code: 0, stdout: '' };
  }

  spawn(args: string[], onLine: (line: string) => void): WslSpawned {
    this.calls.push('spawn');
    const done = Promise.withResolvers<number | null>();
    const s: FakeSpawn = {
      args,
      stopped: false,
      emit: onLine,
      exit: (code) => done.resolve(code),
      exited: done.promise,
      async stop() {
        s.stopped = true;
        done.resolve(null);
      },
    };
    this.spawns.push(s);
    return s;
  }

  async download(url: string, dest: string): Promise<void> {
    this.calls.push(`download ${url} -> ${dest}`);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      await this.gate;
    } finally {
      this.active--;
    }
    if (this.downloadError) throw this.downloadError;
  }
  async fetchText(): Promise<string> {
    this.calls.push('fetchText');
    return this.sums;
  }
  async sha256(): Promise<string> {
    this.calls.push('sha256');
    return this.sha;
  }
  async unzip(zip: string, dir: string): Promise<void> {
    this.calls.push('unzip');
    this.unzipArgs = [zip, dir];
    this.unzipped = true;
  }
  async toWslPath(p: string): Promise<string> {
    return `/mnt/c/${p.replace(/\\/g, '/').slice(3)}`;
  }
  async exists(path: string): Promise<boolean> {
    // Only a promoted dir holds a binary a later run may trust; the stage is checked pre-promote.
    if (path.includes('.part')) return this.unzipped;
    return this.cached || this.promoted.length > 0;
  }
  async promote(stage: string, dir: string): Promise<void> {
    this.calls.push('promote');
    this.promoted.push(`${stage} -> ${dir}`);
  }
  async pruneOthers(): Promise<void> {
    this.calls.push('prune');
  }
  pkills(): number {
    return this.calls.filter((c) => c.startsWith('exec pkill')).length;
  }
}

interface Harness {
  runner: FakeRunner;
  relay: WslRelay;
  /** Distinct consecutive states, without the leading `off`. */
  states: string[];
  logs: Array<[LogLevel, string]>;
  saved: string[];
  last(): WslRelayStatus;
}

function make(over: Partial<WslRelayDeps> = {}, setup?: (r: FakeRunner) => void): Harness {
  const runner = new FakeRunner();
  setup?.(runner);
  const states: string[] = [];
  let last: WslRelayStatus | null = null;
  const logs: Array<[LogLevel, string]> = [];
  const saved: string[] = [];
  const relay = new WslRelay({
    runner,
    version: '9.9.9',
    cacheDir: 'C:\\cache',
    hostIps: () => ['192.168.1.20'],
    target: () => ({ ip: '192.168.1.20' }),
    targetPort: 5343,
    lastIp: () => undefined,
    saveLastIp: (ip) => saved.push(ip),
    log: (l, m) => logs.push([l, m]),
    onStatus: (s) => {
      last = s;
      if (states.at(-1) !== s.state && !(states.length === 0 && s.state === 'off')) {
        states.push(s.state);
      }
    },
    supported: true,
    retryDelayMs: 5,
    ...over,
  });
  return { runner, relay, states, logs, saved, last: () => last ?? relay.status() };
}

async function until(pred: () => boolean, what: string, ms = 1500): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

console.log('\nwsl-relay');

await test('happy path: checking, downloading, starting, ready, paired', async () => {
  const h = make();
  const st = await h.relay.setEnabled(true);
  assert.equal(st.state, 'starting');
  assert.equal(h.runner.spawns.length, 1);
  const sp = h.runner.spawns[0]!;
  assert.equal(sp.args[0], '/mnt/c/cache/wsl-relay/9.9.9/deckbridge');
  assert.equal(
    sp.args.slice(1).join(' '),
    'relay --target 192.168.1.20 --target-port 5343 --no-advertise --name DeckBridge (WSL)',
  );
  sp.emit(L_DOCK);
  assert.equal(h.relay.status().state, 'starting');
  sp.emit(L_LISTEN);
  const ready = h.relay.status();
  assert.equal(ready.state, 'ready');
  assert.equal(ready.wslIp, WSL_IP);
  assert.equal(ready.ipChanged, false);
  assert.equal(ready.distro, 'Ubuntu-24.04');
  assert.deepEqual(h.saved, [], 'ready alone saves nothing: the user has not added the IP yet');
  h.relay.setPaired(true);
  assert.equal(h.relay.status().state, 'paired');
  assert.deepEqual(h.saved, [WSL_IP]);
  h.relay.setPaired(false);
  assert.equal(h.relay.status().state, 'ready');
  h.relay.setPaired(true);
  assert.deepEqual(h.states, [
    'checking',
    'downloading',
    'starting',
    'ready',
    'paired',
    'ready',
    'paired',
  ]);
  const calls = h.runner.calls;
  assert.ok(
    calls.some((c) =>
      c.includes(
        `download https://github.com/lukasMega/DeckBridge/releases/download/deckbridge-v9.9.9/${ZIP}`,
      ),
    ),
  );
  assert.ok(calls.indexOf('sha256') > calls.indexOf('fetchText'));
  assert.ok(calls.indexOf('unzip') > calls.indexOf('sha256'));
  assert.ok(calls.indexOf('promote') > calls.indexOf('unzip'), 'unpacked, then moved into place');
  assert.deepEqual(h.runner.promoted, [
    'C:\\cache\\wsl-relay\\9.9.9.part -> C:\\cache\\wsl-relay\\9.9.9',
  ]);
  assert.ok(h.runner.pkills() >= 1, 'stale relay cleared before the spawn');
  assert.ok(calls.indexOf('spawn') > calls.findIndex((c) => c.startsWith('exec pkill')));
  assert.ok(calls.includes('prune'));
  assert.deepEqual(h.logs.slice(0, 2), [
    ['info', 'dock: sn=A7F pid=0x00a5 child port 5344'],
    ['info', 'listening on 0.0.0.0:5343 and :5344'],
  ]);
});

await test('setPaired before ready lands in paired once the relay listens', async () => {
  const h = make();
  h.relay.setPaired(true);
  await h.relay.setEnabled(true);
  h.runner.spawns[0]!.emit(L_LISTEN);
  assert.equal(h.relay.status().state, 'paired');
});

await test('a cached binary skips the download', async () => {
  const h = make({}, (r) => (r.cached = true));
  await h.relay.setEnabled(true);
  assert.ok(!h.states.includes('downloading'));
  assert.ok(!h.runner.calls.some((c) => c.startsWith('download') || c === 'unzip'));
  assert.equal(h.runner.spawns.length, 1);
});

await test('a checksum mismatch gives download-failed and no spawn', async () => {
  const h = make({}, (r) => (r.sha = 'd'.repeat(64)));
  const st = await h.relay.setEnabled(true);
  assert.equal(st.state, 'download-failed');
  assert.ok(st.detail?.includes('SHA256'));
  assert.equal(h.runner.spawns.length, 0);
  assert.ok(!h.runner.calls.includes('unzip'), 'nothing is unpacked');
});

await test('a missing checksum line or a failed download gives download-failed', async () => {
  const h1 = make({}, (r) => (r.sums = ''));
  assert.equal((await h1.relay.setEnabled(true)).state, 'download-failed');
  const h2 = make({}, (r) => (r.downloadError = new Error('curl.exe exited with 22')));
  const st = await h2.relay.setEnabled(true);
  assert.equal(st.state, 'download-failed');
  assert.ok(st.detail?.includes('curl.exe exited with 22'));
});

await test('no WSL: wsl.exe missing, or "no distributions" text', async () => {
  const h1 = make({}, (r) => (r.detect = new Error('spawn wsl.exe ENOENT')));
  const st1 = await h1.relay.setEnabled(true);
  assert.equal(st1.state, 'no-wsl');
  assert.equal(st1.fixCommand, noWslFix());
  const h2 = make(
    {},
    (r) =>
      (r.detect = {
        code: 1,
        stdout: 'Windows Subsystem for Linux has no installed distributions.\nmore',
      }),
  );
  const st2 = await h2.relay.setEnabled(true);
  assert.equal(st2.state, 'no-wsl');
  assert.equal(st2.detail, 'Windows Subsystem for Linux has no installed distributions.');
});

await test('mirrored is found by the WSL IP matching a host IP', async () => {
  const h = make({ hostIps: () => ['10.0.0.2', WSL_IP] });
  const st = await h.relay.setEnabled(true);
  assert.equal(st.state, 'mirrored');
  assert.ok(st.fixCommand?.includes('.wslconfig'));
  assert.equal(h.runner.spawns.length, 0);
  assert.ok(!h.runner.calls.some((c) => c.startsWith('download')));
});

await test('old glibc and wsl1 stop before any download; recheck re-runs after a fix', async () => {
  const h = make({}, (r) => (r.detect = { code: 0, stdout: DETECT_OK.replace('2.39', '2.35') }));
  const st = await h.relay.setEnabled(true);
  assert.equal(st.state, 'old-glibc');
  assert.equal(h.runner.spawns.length, 0);
  h.runner.detect = { code: 0, stdout: DETECT_OK };
  const again = await h.relay.recheck();
  assert.equal(again.state, 'starting');
  assert.equal(again.fixCommand, null);
  assert.equal(h.runner.spawns.length, 1);
  const w = make(
    {},
    (r) =>
      (r.detect = { code: 0, stdout: DETECT_OK.replace('microsoft-standard-WSL2', 'Microsoft') }),
  );
  assert.equal((await w.relay.setEnabled(true)).state, 'wsl1');
});

await test('blocked becomes ready once DeckBridge answers', async () => {
  const h = make({}, (r) => (r.cached = true));
  await h.relay.setEnabled(true);
  const sp = h.runner.spawns[0]!;
  sp.emit(L_WAIT);
  let s = h.relay.status();
  assert.equal(s.state, 'blocked');
  assert.equal(s.fixCommand, firewallFixCommand());
  assert.ok(s.detail?.includes('ECONNREFUSED'));
  assert.equal(h.logs[0]![0], 'warn');
  sp.emit(L_DOCK);
  s = h.relay.status();
  assert.equal(s.state, 'starting');
  assert.equal(s.fixCommand, null);
  sp.emit(L_LISTEN);
  assert.equal(h.relay.status().state, 'ready');
});

await test('ipChanged compares with the saved IP and saves the new one', async () => {
  const h = make({ lastIp: () => '172.20.0.9' }, (r) => (r.cached = true));
  await h.relay.setEnabled(true);
  h.runner.spawns[0]!.emit(L_LISTEN);
  assert.equal(h.relay.status().ipChanged, true);
  assert.deepEqual(h.saved, [], 'not saved at ready');
  h.runner.spawns[0]!.exit(1); // a restart before the user re-added the IP: still changed
  await until(() => h.runner.spawns.length === 2, 'the retry');
  h.runner.spawns[1]!.emit(L_LISTEN);
  assert.equal(h.relay.status().ipChanged, true, 'still flagged until paired');
  h.relay.setPaired(true);
  assert.equal(h.relay.status().ipChanged, false);
  assert.deepEqual(h.saved, [WSL_IP]);
  const same = make({ lastIp: () => WSL_IP }, (r) => (r.cached = true));
  await same.relay.setEnabled(true);
  same.runner.spawns[0]!.emit(L_LISTEN);
  assert.equal(same.relay.status().ipChanged, false);
});

await test('disable stops the spawn, cleans up and goes off', async () => {
  const h = make({}, (r) => (r.cached = true));
  await h.relay.setEnabled(true);
  const sp = h.runner.spawns[0]!;
  sp.emit(L_LISTEN);
  const before = h.runner.pkills();
  const st = await h.relay.setEnabled(false);
  assert.equal(sp.stopped, true);
  assert.equal(h.runner.pkills(), before + 1);
  assert.ok(
    h.runner.pkillTimeouts.length > 0 && h.runner.pkillTimeouts.every((t) => t <= 3000),
    'the pkill cleanup is bounded to 3 s',
  );
  assert.equal(st.state, 'off');
  assert.equal(st.enabled, false);
  assert.equal(st.wslIp, null);
  sp.emit(L_WAIT); // a late line must not revive the state
  assert.equal(h.relay.status().state, 'off');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.runner.spawns.length, 1, 'a stopped relay is not restarted');
});

await test('an unexpected exit retries once, then reports the last relay line', async () => {
  const h = make({}, (r) => (r.cached = true));
  await h.relay.setEnabled(true);
  const first = h.runner.spawns[0]!;
  first.emit(
    stamp('ERROR', "can't listen on 0.0.0.0:5343 or :5344 (EADDRINUSE). Is DeckBridge running?"),
  );
  first.exit(1);
  await until(() => h.runner.spawns.length === 2, 'the retry');
  assert.equal(h.relay.status().state, 'starting');
  h.runner.spawns[1]!.emit(stamp('ERROR', "can't listen on 0.0.0.0:5343 or :5344 (EADDRINUSE)."));
  h.runner.spawns[1]!.exit(1);
  await until(() => h.relay.status().state === 'error', 'error');
  assert.ok(h.relay.status().detail?.startsWith("can't listen on"));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.runner.spawns.length, 2, 'only one retry');
});

await test('a loader GLIBC failure ends as old-glibc', async () => {
  const h = make({}, (r) => (r.cached = true));
  await h.relay.setEnabled(true);
  for (let i = 0; i < 2; i++) {
    await until(() => h.runner.spawns.length === i + 1, 'spawn');
    h.runner.spawns[i]!.emit(
      "deckbridge: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.38' not found",
    );
    h.runner.spawns[i]!.exit(1);
  }
  await until(() => h.relay.status().state === 'old-glibc', 'old-glibc');
  assert.ok(h.relay.status().fixCommand?.includes('Ubuntu-24.04'));
});

await test('zipOverride: a local path skips download and checksum', async () => {
  const h = make({ zipOverride: 'D:\\dev\\relay-dev.zip' });
  await h.relay.setEnabled(true);
  assert.equal(h.runner.spawns.length, 1);
  assert.deepEqual(h.runner.unzipArgs, [
    'D:\\dev\\relay-dev.zip',
    'C:\\cache\\wsl-relay\\9.9.9.part',
  ]);
  assert.ok(
    !h.runner.calls.some((c) => c.startsWith('download') || c === 'sha256' || c === 'fetchText'),
  );
});

await test('zipOverride: a URL is downloaded without a checksum', async () => {
  const h = make({ zipOverride: 'https://example.test/dev.zip' });
  await h.relay.setEnabled(true);
  assert.ok(h.runner.calls.some((c) => c.startsWith('download https://example.test/dev.zip')));
  assert.ok(!h.runner.calls.includes('sha256'));
  assert.equal(h.runner.spawns.length, 1);
});

await test('unsupported: setEnabled does nothing', async () => {
  const h = make({ supported: false });
  const st = await h.relay.setEnabled(true);
  assert.equal(st.supported, false);
  assert.equal(st.state, 'off');
  assert.equal(st.enabled, false);
  assert.equal(h.runner.calls.length, 0);
});

await test('stop() at shutdown kills the relay but keeps the switch on', async () => {
  const h = make({}, (r) => (r.cached = true));
  await h.relay.setEnabled(true);
  await h.relay.stop();
  assert.equal(h.runner.spawns[0]!.stopped, true);
  assert.equal(h.relay.status().state, 'off');
  assert.equal(h.relay.status().enabled, true);
  await h.relay.stop(); // idempotent, no second cleanup
});

await test('a crash after a good start gets its retry again', async () => {
  const h = make({}, (r) => (r.cached = true));
  await h.relay.setEnabled(true);
  h.runner.spawns[0]!.exit(1); // first crash: retried
  await until(() => h.runner.spawns.length === 2, 'first retry');
  h.runner.spawns[1]!.emit(L_LISTEN); // ready again
  h.runner.spawns[1]!.exit(1); // a later crash must be retried too
  await until(() => h.runner.spawns.length === 3, 'second retry');
  h.runner.spawns[2]!.exit(1);
  await until(() => h.relay.status().state === 'error', 'error');
  assert.equal(h.runner.spawns.length, 3);
});

await test('a detect timeout is an error to retry, not "no WSL"', async () => {
  const h = make({}, (r) => (r.detect = { code: 137, stdout: '', timedOut: true }));
  const st = await h.relay.setEnabled(true);
  assert.equal(st.state, 'error');
  assert.equal(st.detail, 'WSL took too long to start. Press Check again.');
  assert.equal(st.fixCommand, null);
  assert.equal(h.runner.detectTimeouts[0], 60_000, 'a cold WSL boot gets a minute');
  h.runner.detect = { code: 0, stdout: DETECT_OK };
  assert.equal((await h.relay.recheck()).state, 'starting');
});

await test('an interrupted extract is not trusted; the binary appears only by promote', async () => {
  const h = make();
  h.runner.unzip = () => Promise.reject(new Error('tar.exe exited with 1'));
  const st = await h.relay.setEnabled(true);
  assert.equal(st.state, 'download-failed');
  assert.deepEqual(h.runner.promoted, [], 'nothing reaches the final dir');
  assert.equal(await h.runner.exists('C:\\cache\\wsl-relay\\9.9.9\\deckbridge'), false);
});

await test('flows are serialized: a toggle during a download waits for it', async () => {
  const gate = Promise.withResolvers<void>();
  const h = make({}, (r) => {
    r.gate = gate.promise;
  });
  const first = h.relay.setEnabled(true);
  await until(() => h.runner.active === 1, 'download started');
  await h.relay.setEnabled(false);
  const second = h.relay.setEnabled(true); // a newer flow while the old one still downloads
  const again = h.relay.recheck();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.runner.active, 1, 'no second download overlaps the first');
  assert.equal(h.relay.status().state, 'checking');
  gate.resolve();
  await Promise.all([first, second, again]);
  assert.equal(h.runner.maxActive, 1);
  assert.equal(h.runner.spawns.length, 1, 'only the newest flow launches the relay');
  assert.equal(h.relay.status().state, 'starting');
});

await test('the relay target: --bind IP is used, loopback and no address are errors', async () => {
  const a = make({ target: () => ({ ip: '10.0.0.7' }) }, (r) => (r.cached = true));
  await a.relay.setEnabled(true);
  assert.equal(
    a.runner.spawns[0]!.args[a.runner.spawns[0]!.args.indexOf('--target') + 1],
    '10.0.0.7',
  );
  for (const error of [
    "DeckBridge is bound to 127.0.0.1; WSL can't reach it. Remove the bind setting.",
    'No network address found',
  ]) {
    const h = make({ target: () => ({ error }) }, (r) => (r.cached = true));
    const st = await h.relay.setEnabled(true);
    assert.equal(st.state, 'error');
    assert.equal(st.detail, error);
    assert.equal(h.runner.spawns.length, 0);
    assert.equal(h.runner.calls.length, 0, 'nothing runs without a target');
  }
});

await test('unsupported with no runner: nothing is ever built or called', async () => {
  const h = make({ supported: false, runner: null });
  assert.equal((await h.relay.setEnabled(true)).state, 'off');
  assert.equal((await h.relay.recheck()).state, 'off');
  await h.relay.stop();
});

await test('mock runner happy scenario reaches ready', async () => {
  const h = make({ runner: createMockWslRunner('happy', 10) });
  await h.relay.setEnabled(true);
  await until(() => h.relay.status().state === 'ready', 'mock ready');
  assert.deepEqual(h.states.slice(0, 4), ['checking', 'downloading', 'starting', 'ready']);
  await h.relay.stop();
});

await test('mock runner scenarios no-wsl, mirrored, old-glibc, blocked', async () => {
  for (const [scn, want] of [
    ['no-wsl', 'no-wsl'],
    ['mirrored', 'mirrored'],
    ['old-glibc', 'old-glibc'],
  ] as const) {
    const h = make({ runner: createMockWslRunner(scn, 5) });
    assert.equal((await h.relay.setEnabled(true)).state, want);
  }
  const b = make({ runner: createMockWslRunner('blocked', 10) });
  await b.relay.setEnabled(true);
  await until(() => b.relay.status().state === 'blocked', 'mock blocked');
  await b.relay.stop();
});

summaryExit();
