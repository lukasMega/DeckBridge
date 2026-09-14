import assert from 'tjs:assert';
import {
  buildDiagnostics,
  diagnosticsFileName,
  DEFAULT_LOG_TAIL_LINES,
  REVIEW_NOTICE,
} from '../src/web/server/diagnostics.js';
import type { DiagnosticsSources } from '../src/web/server/diagnostics.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

const SETTINGS_WITH_COMMANDS = JSON.stringify(
  {
    selectedDock: 0,
    devices: [
      {
        deviceKey: 'usb:ABC123:mirabox-293s',
        mdnsServiceName: 'Network Stream Deck',
        macAddress: '02:1a:2b:3c:4d:5e',
        dockSerial: 'A7FZA5190ILSAA',
        childSerial: 'A7FZA5191ILSNQ',
        extraKeys: {
          '16': { widget: 'command', param: '/Users/me/secret-script.sh --token hunter2' },
          '17': { widget: 'plugin', param: 'weather.js', pluginArg: '/home/me/apikey.txt' },
          '18': { widget: 'clock' },
        },
      },
    ],
  },
  null,
  2,
);

/** A fully populated source set — every section has data, so "missing" tests can
 *  subtract from it rather than each building their own. */
function fullSources(): DiagnosticsSources {
  return {
    header: {
      version: 'deckbridge 0.11.1 (built 2026-09-14)',
      platform: 'macOS',
      txikiVersion: '24.0.0',
      cpus: '10x Apple M1 Pro',
      uptimeMs: 3_725_000,
      logLevel: 'debug',
    },
    flags: { mock: false, headless: true, logLevel: 'debug' },
    env: { DECKBRIDGE_NATIVE_LIB: '/opt/deckbridge/libdeckbridge_native.dylib', HIDAPI_LIB: '' },
    paths: {
      cacheRoot: '/home/u/.cache/deckbridge',
      settingsPath: '/home/u/.cache/deckbridge/settings.json',
      logPath: '/home/u/.cache/deckbridge/logs/deckbridge.log',
    },
    modelOverrides: { 'ajazz-akp153e-rev2': { image: { rotate: 180 } } },
    effectiveModels: { 'ajazz-akp153e-rev2': { image: { rotate: 180 } } },
    hidDevices: [
      {
        vendorId: 0x0300,
        productId: 0x3010,
        usagePage: 0xffa0,
        usage: 1,
        interfaceNumber: 0,
        manufacturer: 'Ajazz',
        product: 'AKP153E',
        serial: 'SN-1',
        path: 'DevSrvsID:42',
      },
      {
        vendorId: 0x3434,
        productId: 0x0361,
        usagePage: 0x0001,
        usage: 6,
        interfaceNumber: 1,
        manufacturer: 'Keychron',
        product: 'Lemokey P1 Pro',
        serial: '-',
        path: 'DevSrvsID:99',
      },
    ],
    deviceRows: [
      {
        model: 'Ajazz AKP153E (rev. 2)',
        vidPid: '0300:3010',
        serial: 'SN-1',
        path: 'DevSrvsID:42',
        supported: 'yes',
      },
    ],
    requirements: [
      { name: 'libhidapi', ok: true, message: 'Found (bundled): /opt/deckbridge/libhidapi.dylib' },
      {
        name: 'mdns',
        ok: false,
        message: 'avahi-daemon not running',
        installHint: 'apt install avahi-daemon',
      },
    ],
    comms: [
      {
        ts: 1_760_000_000_000,
        direction: 'rx',
        protocol: 'elgato',
        component: 'child',
        human: 'SET_IMAGE key=3',
        hex: 'ffd8',
        totalBytes: 1024,
      },
    ],
    keyEvents: [{ ts: 1_760_000_000_001, mk2Index: 3, state: 'down', wireId: 14 }],
    logTail: '10:00:00.000 INFO  [deckBr] started\n10:00:01.000 WARN  [hid] no device found',
    ringLogs: [
      { ts: 1_760_000_000_002, level: 'error', component: 'hid', message: 'ring fallback' },
    ],
    settingsJson: SETTINGS_WITH_COMMANDS,
  };
}

/** Section titles the report must always carry, in any mode. */
const SECTIONS = [
  'deckbridge diagnostics',
  'cli flags',
  'environment (DECKBRIDGE_*)',
  'paths',
  'model overrides',
  'effective model specs',
  'hid enumeration (all devices)',
  'registry matches',
  'requirements',
  'docks / live state',
  'log tail',
  'cora comm buffer',
  'key events',
  'settings.json',
];

// Sections

console.log('\nsections');

test('every section is present with populated sources', () => {
  const report = buildDiagnostics(fullSources());
  for (const title of SECTIONS) {
    assert.ok(report.includes(title), `missing section: ${title}`);
  }
});

test('every section is still present with only the header', () => {
  // A partial report must still reach the issue — "(unavailable)" tells a reader
  // "no data" rather than leaving them guessing whether it was ever collected.
  const report = buildDiagnostics({ header: fullSources().header });
  for (const title of SECTIONS) {
    assert.ok(report.includes(title), `missing section: ${title}`);
  }
  assert.ok(report.includes('(unavailable)'), 'absent sources render as (unavailable)');
});

test('header carries version, platform, txiki version, uptime and log level', () => {
  const report = buildDiagnostics(fullSources());
  assert.ok(report.includes('deckbridge 0.11.1'), 'version');
  assert.ok(report.includes('macOS'), 'platform');
  assert.ok(report.includes('24.0.0'), 'txiki version');
  assert.ok(report.includes('1h 2m 5s'), 'uptime is formatted');
  assert.ok(report.includes('debug'), 'log level');
});

test('the unfiltered HID table includes devices DeckBridge does not recognize', () => {
  // The whole point of the full enumeration: a keyboard DeckBridge never opens
  // is exactly the suspect in the "freeze when a keyboard is plugged in" report.
  const report = buildDiagnostics(fullSources());
  assert.ok(report.includes('Lemokey P1 Pro'), 'the unknown keyboard is listed');
  assert.ok(report.includes('3434:0361'), 'its VID:PID is shown in hex');
});

test('the enumeration duration rides in the HID section title', () => {
  // The presence sweep runs this same enumeration on the main thread, so a
  // four-figure number here IS the "DeckBridge freezes" report (issue #67.2).
  const slow = buildDiagnostics({ ...fullSources(), hidEnumerateMs: 4200 });
  assert.ok(slow.includes('hid enumeration (all devices, took 4200ms)'), 'duration shown');
  const unknown = buildDiagnostics(fullSources());
  assert.ok(unknown.includes('hid enumeration (all devices)'), 'omitted when not measured');
});

test('failing requirements show their install hint', () => {
  const report = buildDiagnostics(fullSources());
  assert.ok(report.includes('avahi-daemon not running'));
  assert.ok(report.includes('apt install avahi-daemon'));
});

// Model overrides — the "this is not default behaviour" flag

console.log('\nmodel overrides');

test('active overrides are flagged loudly', () => {
  const report = buildDiagnostics(fullSources());
  assert.ok(report.includes('USER OVERRIDES'), 'the warning is unmissable');
  assert.ok(report.includes('ajazz-akp153e-rev2'), 'the tuned model is named');
});

test('an empty override map says so explicitly', () => {
  const report = buildDiagnostics({ ...fullSources(), modelOverrides: {} });
  assert.ok(report.includes('registry defaults'), 'states that nothing is tuned');
  assert.ok(!report.includes('USER OVERRIDES'), 'no false alarm');
});

// Redaction

console.log('\nredaction');

test('commands are included verbatim by default', () => {
  const report = buildDiagnostics(fullSources());
  assert.ok(report.includes('hunter2'), 'extra-key command is present');
  assert.ok(report.includes('/home/me/apikey.txt'), 'plugin arg is present');
});

test('--redact-commands replaces param and pluginArg only', () => {
  const report = buildDiagnostics(fullSources(), { redactCommands: true });
  assert.ok(!report.includes('hunter2'), 'command is gone');
  assert.ok(!report.includes('/home/me/apikey.txt'), 'plugin arg is gone');
  assert.ok(report.includes('<redacted>'), 'replaced, not dropped');
  assert.ok(report.includes('usb:ABC123:mirabox-293s'), 'the rest of settings.json survives');
  assert.ok(report.includes('"widget": "clock"'), 'a command-less widget is untouched');
});

test('unparsable settings redact to (unavailable) rather than leaking', () => {
  const report = buildDiagnostics(
    { ...fullSources(), settingsJson: 'not json{{{' },
    { redactCommands: true },
  );
  assert.ok(!report.includes('not json'), 'raw text could hold commands anywhere');
  assert.ok(report.includes('(unavailable)'));
});

// The review notice

console.log('\nreview notice');

test('the notice is the first line in both modes', () => {
  for (const redactCommands of [false, true]) {
    const [firstLine] = buildDiagnostics(fullSources(), { redactCommands }).split('\n');
    assert.equal(firstLine, REVIEW_NOTICE, `redactCommands=${redactCommands}`);
  }
});

test('the notice names --redact-commands so it survives a copy-paste', () => {
  assert.ok(REVIEW_NOTICE.includes('--redact-commands'));
  assert.ok(REVIEW_NOTICE.includes('Review'));
});

// Log tail

console.log('\nlog tail');

test('the file tail wins over the ring buffer', () => {
  const report = buildDiagnostics(fullSources());
  assert.ok(report.includes('[deckBr] started'), 'file tail is used');
  assert.ok(!report.includes('ring fallback'), 'ring buffer not duplicated');
});

test('an empty file tail falls back to the ring buffer', () => {
  const report = buildDiagnostics({ ...fullSources(), logTail: '' });
  assert.ok(report.includes('ring fallback'), 'ring buffer is the fallback');
});

test('the tail respects the line cap', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line-${i}`).join('\n');
  const report = buildDiagnostics({ ...fullSources(), logTail: lines }, { logTailLines: 5 });
  assert.ok(report.includes('line-49'), 'newest lines kept');
  assert.ok(!report.includes('line-40'), 'older lines dropped');
});

test('the default cap is named in the section heading', () => {
  const report = buildDiagnostics(fullSources());
  assert.ok(report.includes(`last ${DEFAULT_LOG_TAIL_LINES} lines`));
});

// Robustness

console.log('\nrobustness');

test('never throws when sources are missing (no device, no server, no log file)', () => {
  const header = fullSources().header;
  // The CLI path: no live server, so no dock state / ring buffers.
  assert.ok(buildDiagnostics({ header, hidDevices: [], deviceRows: [] }).length > 0);
  // Nothing at all beyond the header.
  assert.ok(buildDiagnostics({ header }).length > 0);
  assert.ok(buildDiagnostics({ header }, { redactCommands: true }).length > 0);
});

test('empty tables read as "(none)", not as an empty block', () => {
  const report = buildDiagnostics({ ...fullSources(), hidDevices: [], deviceRows: [], comms: [] });
  assert.ok(report.includes('(none)'));
});

// Filename

console.log('\ndiagnosticsFileName');

test('is prefixed, timestamped, and free of characters Windows rejects', () => {
  const name = diagnosticsFileName(new Date(Date.UTC(2026, 8, 14, 10, 30, 0)));
  assert.ok(name.startsWith('deckbridge-diagnostics-'), name);
  assert.ok(name.endsWith('.txt'), name);
  assert.ok(!name.includes(':'), 'no colons — Windows rejects them in filenames');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) tjs.exit(1);
