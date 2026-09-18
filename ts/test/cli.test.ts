import assert from 'tjs:assert';
import {
  userArgs,
  parseCliArgs,
  applyFlagsToEnv,
  isLogLevel,
  versionText,
  USAGE_TEXT,
} from '../src/cli.js';
import type { CliFlags } from '../src/cli.js';
import { test, summary } from './helpers/harness.js';

const ENV_KEYS = [
  'DECKBRIDGE_MOCK',
  'DECKBRIDGE_BIND',
  'DECKBRIDGE_OPEN',
  'DECKBRIDGE_WEBUI_PORT',
  'DECKBRIDGE_HEADLESS',
  'DECKBRIDGE_CACHE_DIR',
  'DECKBRIDGE_LOG_LEVEL',
  'DECKBRIDGE_NO_OVERRIDES',
  'DECKBRIDGE_NO_TELEMETRY',
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) out[k] = tjs.env[k];
  return out;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete tjs.env[k];
    else tjs.env[k] = snap[k]!;
  }
}

const NO_FLAGS: CliFlags = {
  mock: false,
  noWebui: false,
  open: false,
  headless: false,
  redactCommands: false,
  noOverrides: false,
  noTelemetry: false,
};

// userArgs(): both invocation shapes

console.log('\nuserArgs');

test('tjs run <bundle> <flags> shape (args[1] === "run") strips the first 3', () => {
  const args = ['tjs', 'run', 'ts/dist/bundle.js', '--mock', '--headless'];
  assert.deepEqual(userArgs(args), ['--mock', '--headless']);
});

test('compiled ./deckbridge <flags> shape strips only argv[0]', () => {
  const args = ['deckbridge', '--mock', '--headless'];
  assert.deepEqual(userArgs(args), ['--mock', '--headless']);
});

test('tjs run <bundle> with no flags → empty', () => {
  assert.deepEqual(userArgs(['tjs', 'run', 'ts/dist/bundle.js']), []);
});

test('compiled with no flags → empty', () => {
  assert.deepEqual(userArgs(['deckbridge']), []);
});

test('compiled ./deckbridge run <flags> keeps the command word AND every flag', () => {
  // Regression: `args[1] === "run"` alone can't tell this from the `tjs run
  // <script>` shape, and treating it as that ate both the command word and the
  // first flag — `./deckbridge run --mock --headless` started without the mock
  // driver. The script path is the discriminator.
  assert.deepEqual(userArgs(['deckbridge', 'run', '--mock', '--headless']), [
    'run',
    '--mock',
    '--headless',
  ]);
  assert.deepEqual(userArgs(['deckbridge', 'run']), ['run']);
  assert.deepEqual(userArgs(['deckbridge', 'run', '--no-overrides']), ['run', '--no-overrides']);
});

test('./deckbridge run <flags> still parses to command "run" with the flags set', () => {
  const r = parseCliArgs(userArgs(['deckbridge', 'run', '--mock', '--no-overrides']));
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.cli.command, 'run');
    assert.equal(r.cli.flags.mock, true, 'the flag right after `run` is not swallowed');
    assert.equal(r.cli.flags.noOverrides, true);
  }
});

test('tjs run <script> is still stripped, flags intact', () => {
  assert.deepEqual(userArgs(['tjs', 'run', '/abs/path/bundle.js', '--mock']), ['--mock']);
});

test('userArgs() with no override reads the real (frozen) tjs.args', () => {
  // Sanity check against the actual test-runner invocation: $TJS run dist/test/cli.js
  // is the "tjs run <bundle>" shape (tjs.args[1] === 'run'), so this should be [].
  assert.equal(tjs.args[1], 'run');
  assert.deepEqual(userArgs(), []);
});

// parseCliArgs: commands

console.log('\nparseCliArgs — commands');

test('no args → command "run", default flags', () => {
  const r = parseCliArgs([]);
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.cli, { command: 'run', flags: NO_FLAGS });
});

test('"devices" → command "devices"', () => {
  const r = parseCliArgs(['devices']);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.cli.command, 'devices');
});

test('"diagnose" → command "diagnose"', () => {
  const r = parseCliArgs(['diagnose']);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.cli.command, 'diagnose');
});

test('diagnose accepts --out and --redact-commands', () => {
  const outPath = `${tjs.tmpDir}/deckbridge-report.txt`;
  const r = parseCliArgs(['diagnose', '--out', outPath, '--redact-commands']);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.cli.command, 'diagnose');
    assert.equal(r.cli.flags.out, outPath);
    assert.equal(r.cli.flags.redactCommands, true);
  }
});

test('--out without a value is an error, not a silent default', () => {
  const r = parseCliArgs(['diagnose', '--out']);
  assert.ok(!r.ok);
  if (!r.ok) assert.ok(r.error.includes('--out'));
});

test('--redact-commands defaults to false (commands included verbatim)', () => {
  const r = parseCliArgs(['diagnose']);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.cli.flags.redactCommands, false);
});

test('run --no-overrides sets the safe-mode flag', () => {
  const r = parseCliArgs(['run', '--no-overrides']);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.cli.command, 'run');
    assert.equal(r.cli.flags.noOverrides, true);
  }
});

test('"version" → command "version"', () => {
  const r = parseCliArgs(['version']);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.cli.command, 'version');
});

test('"help" → command "help"', () => {
  const r = parseCliArgs(['help']);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.cli.command, 'help');
});

test('"run" explicit → command "run"', () => {
  const r = parseCliArgs(['run', '--mock']);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.cli.command, 'run');
    assert.equal(r.cli.flags.mock, true);
  }
});

test('-h anywhere → command "help"', () => {
  const r = parseCliArgs(['-h']);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.cli.command, 'help');
});

test('--version anywhere → command "version"', () => {
  const r = parseCliArgs(['--version']);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.cli.command, 'version');
});

test('unknown command word → error, not thrown/exited', () => {
  const r = parseCliArgs(['bogus']);
  assert.ok(!r.ok);
  if (!r.ok) assert.ok(r.error.includes('bogus'));
});

// parseCliArgs: flag matrix

console.log('\nparseCliArgs — flag matrix');

test('--mock', () => {
  const r = parseCliArgs(['--mock']);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.cli.flags.mock, true);
});

test('--bind <addr>', () => {
  const r = parseCliArgs(['--bind', '127.0.0.1']);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.cli.flags.bind, '127.0.0.1');
});

test('--bind with no value → error', () => {
  const r = parseCliArgs(['--bind']);
  assert.ok(!r.ok);
});

test('--webui-port <n>', () => {
  const r = parseCliArgs(['--webui-port', '4000']);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.cli.flags.webuiPort, 4000);
});

test('--webui-port non-numeric → error', () => {
  const r = parseCliArgs(['--webui-port', 'nope']);
  assert.ok(!r.ok);
});

test('--webui-port negative → error', () => {
  const r = parseCliArgs(['--webui-port', '-1']);
  assert.ok(!r.ok);
});

test('--no-webui', () => {
  const r = parseCliArgs(['--no-webui']);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.cli.flags.noWebui, true);
});

test('--open', () => {
  const r = parseCliArgs(['--open']);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.cli.flags.open, true);
});

test('--headless', () => {
  const r = parseCliArgs(['--headless']);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.cli.flags.headless, true);
});

test('--log-level debug', () => {
  const r = parseCliArgs(['--log-level', 'debug']);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.cli.flags.logLevel, 'debug');
});

test('--log-level silent', () => {
  const r = parseCliArgs(['--log-level', 'silent']);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.cli.flags.logLevel, 'silent');
});

test('--log-level invalid → error', () => {
  const r = parseCliArgs(['--log-level', 'loud']);
  assert.ok(!r.ok);
});

const CACHE_DIR = `${tjs.tmpDir}/deckbridge-cache`;
const OTHER_CACHE_DIR = `${tjs.tmpDir}/deckbridge-cache-2`;

test('--cache-dir <path>', () => {
  const r = parseCliArgs(['--cache-dir', CACHE_DIR]);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.cli.flags.cacheDir, CACHE_DIR);
});

test('combined flags all land correctly', () => {
  const r = parseCliArgs([
    '--mock',
    '--bind',
    '0.0.0.0',
    '--webui-port',
    '3001',
    '--no-webui',
    '--headless',
    '--log-level',
    'warn',
    '--cache-dir',
    OTHER_CACHE_DIR,
  ]);
  assert.ok(r.ok);
  if (r.ok) {
    assert.deepEqual(r.cli.flags, {
      mock: true,
      bind: '0.0.0.0',
      webuiPort: 3001,
      noWebui: true,
      open: false,
      headless: true,
      logLevel: 'warn',
      cacheDir: OTHER_CACHE_DIR,
      redactCommands: false,
      noOverrides: false,
      noTelemetry: false,
    });
  }
});

test('unknown flag → error (not exit)', () => {
  const r = parseCliArgs(['--bogus-flag']);
  assert.ok(!r.ok);
  if (!r.ok) assert.ok(r.error.includes('--bogus-flag'));
});

// applyFlagsToEnv: precedence (CLI flag > pre-existing env > default)

console.log('\napplyFlagsToEnv — precedence');

test('flag absent → pre-existing env var is left untouched', () => {
  const snap = snapshotEnv();
  tjs.env.DECKBRIDGE_BIND = 'pre-existing';
  applyFlagsToEnv(NO_FLAGS);
  assert.equal(tjs.env.DECKBRIDGE_BIND, 'pre-existing');
  restoreEnv(snap);
});

test('flag given → overrides pre-existing env var', () => {
  const snap = snapshotEnv();
  tjs.env.DECKBRIDGE_BIND = 'pre-existing';
  applyFlagsToEnv({ ...NO_FLAGS, bind: '127.0.0.1' });
  assert.equal(tjs.env.DECKBRIDGE_BIND, '127.0.0.1');
  restoreEnv(snap);
});

test('boolean flags only set env when true', () => {
  const snap = snapshotEnv();
  delete tjs.env.DECKBRIDGE_MOCK;
  delete tjs.env.DECKBRIDGE_HEADLESS;
  delete tjs.env.DECKBRIDGE_OPEN;
  applyFlagsToEnv(NO_FLAGS);
  assert.equal(tjs.env.DECKBRIDGE_MOCK, undefined);
  assert.equal(tjs.env.DECKBRIDGE_HEADLESS, undefined);
  assert.equal(tjs.env.DECKBRIDGE_OPEN, undefined);
  applyFlagsToEnv({ ...NO_FLAGS, mock: true, headless: true, open: true });
  assert.equal(tjs.env.DECKBRIDGE_MOCK, '1');
  assert.equal(tjs.env.DECKBRIDGE_HEADLESS, '1');
  assert.equal(tjs.env.DECKBRIDGE_OPEN, '1');
  restoreEnv(snap);
});

test('--webui-port / --cache-dir / --log-level land in tjs.env', () => {
  const snap = snapshotEnv();
  applyFlagsToEnv({ ...NO_FLAGS, webuiPort: 4001, cacheDir: CACHE_DIR, logLevel: 'error' });
  assert.equal(tjs.env.DECKBRIDGE_WEBUI_PORT, '4001');
  assert.equal(tjs.env.DECKBRIDGE_CACHE_DIR, CACHE_DIR);
  assert.equal(tjs.env.DECKBRIDGE_LOG_LEVEL, 'error');
  restoreEnv(snap);
});

test('--no-overrides lands in tjs.env (read by DriverManager at module load)', () => {
  const snap = snapshotEnv();
  delete tjs.env.DECKBRIDGE_NO_OVERRIDES;
  applyFlagsToEnv(NO_FLAGS);
  assert.equal(tjs.env.DECKBRIDGE_NO_OVERRIDES, undefined, 'absent flag sets nothing');
  applyFlagsToEnv({ ...NO_FLAGS, noOverrides: true });
  assert.equal(tjs.env.DECKBRIDGE_NO_OVERRIDES, '1');
  restoreEnv(snap);
});

// isLogLevel — the single source of truth shared with settings.json + /api/log-level

console.log('\nisLogLevel');

test('accepts every documented level', () => {
  for (const level of ['debug', 'info', 'warn', 'error', 'silent']) {
    assert.ok(isLogLevel(level), `${level} is a valid level`);
  }
});

test('rejects anything else', () => {
  for (const bad of ['DEBUG', 'trace', '', 'verbose', undefined, null, 3]) {
    assert.ok(!isLogLevel(bad), `${String(bad)} is not a valid level`);
  }
});

// help / version text

console.log('\nhelp / version text');

test('USAGE_TEXT mentions every flag', () => {
  for (const flag of [
    '--mock',
    '--bind',
    '--webui-port',
    '--no-webui',
    '--open',
    '--headless',
    '--log-level',
    '--cache-dir',
    '--help',
    '--version',
  ]) {
    assert.ok(USAGE_TEXT.includes(flag), `USAGE_TEXT missing ${flag}`);
  }
});

test('versionText() includes the build define values', () => {
  assert.ok(versionText().includes('deckbridge'));
});

// Summary

summary();
