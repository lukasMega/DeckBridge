/* eslint-disable sonarjs/no-hardcoded-ip -- fixture address, nothing is contacted */
import assert from 'tjs:assert';
import {
  classifyDetect,
  DETECT_SCRIPT,
  decodeWslText,
  findSha256,
  firewallFixCommand,
  isIPv4,
  noWslFix,
  parseDetect,
  parseRelayLine,
  releaseZipUrl,
  relayTarget,
  sumsUrl,
  zipArch,
  zipName,
} from '../src/infra/wsl-relay-parse.js';
import { test, summary } from './helpers/harness.js';

const OK = [
  'kernel=5.15.153.1-microsoft-standard-WSL2',
  'arch=x86_64',
  'glibc=glibc 2.39',
  'ip=172.28.16.5 fd00::1',
  'mode=nat',
  'distro=Ubuntu-24.04',
].join('\n');

function utf16(text: string, bom = false): Uint8Array {
  const out = new Uint8Array((text.length + (bom ? 1 : 0)) * 2);
  let at = 0;
  if (bom) {
    out[at++] = 0xff;
    out[at++] = 0xfe;
  }
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    out[at++] = c & 0xff;
    out[at++] = c >> 8;
  }
  return out;
}

const p = (lvl: string, m: string): string => `12:00:00.123 ${lvl} [relay] ${m}`;

console.log('\nwsl-relay-parse');

test('DETECT_SCRIPT has no quotes (wsl.exe re-parses the command line)', () => {
  assert.ok(!DETECT_SCRIPT.includes('"') && !DETECT_SCRIPT.includes("'"));
  for (const k of ['kernel', 'arch', 'glibc', 'ip', 'mode', 'distro']) {
    assert.ok(DETECT_SCRIPT.includes(`echo ${k}=`));
  }
});

test('parseDetect reads the fields and the first IPv4', () => {
  const d = parseDetect(OK);
  assert.equal(d.kernel, '5.15.153.1-microsoft-standard-WSL2');
  assert.equal(d.arch, 'x86_64');
  assert.equal(d.glibc, '2.39');
  assert.equal(d.wslIp, '172.28.16.5');
  assert.equal(d.mode, 'nat');
  assert.equal(d.distro, 'Ubuntu-24.04');
  assert.equal(d.wsl2, true);
});

test('parseDetect tolerates CRLF, missing keys and IPv6-only ip', () => {
  const d = parseDetect('kernel=4.4.0-19041-Microsoft\r\nip=fd00::1\r\n');
  assert.equal(d.wsl2, false);
  assert.equal(d.wslIp, null);
  assert.equal(d.glibc, '');
  assert.equal(parseDetect('').wslIp, null);
});

test('classifyDetect: all fine is null', () => {
  assert.equal(classifyDetect(parseDetect(OK), ['192.168.1.20']), null);
});

test('classifyDetect: wsl1', () => {
  const r = classifyDetect(
    parseDetect('kernel=4.4.0-19041-Microsoft\narch=x86_64\ndistro=Ubuntu\nip=192.168.1.20'),
    [],
  );
  assert.equal(r?.state, 'wsl1');
  assert.equal(r?.fixCommand, 'wsl --set-version Ubuntu 2');
});

test('classifyDetect: mirrored by mode', () => {
  const r = classifyDetect(parseDetect(OK.replace('mode=nat', 'mode=Mirrored')), []);
  assert.equal(r?.state, 'mirrored');
  assert.ok(r?.fixCommand.includes('.wslconfig') && r.fixCommand.includes('wsl --shutdown'));
});

test('classifyDetect: mirrored by WSL IP equal to a host IP', () => {
  const r = classifyDetect(parseDetect(OK), ['10.0.0.2', '172.28.16.5']);
  assert.equal(r?.state, 'mirrored');
});

test('classifyDetect: old glibc, boundary 2.38 is fine', () => {
  const old = classifyDetect(parseDetect(OK.replace('2.39', '2.35')), []);
  assert.equal(old?.state, 'old-glibc');
  assert.ok(old?.fixCommand.includes('Ubuntu-24.04'));
  assert.equal(classifyDetect(parseDetect(OK.replace('2.39', '2.38')), []), null);
  assert.equal(classifyDetect(parseDetect(OK.replace('2.39', '3.0')), []), null);
  assert.equal(classifyDetect(parseDetect(OK.replace('2.39', '1.99')), [])?.state, 'old-glibc');
});

test('classifyDetect: unknown glibc is not blamed', () => {
  assert.equal(classifyDetect(parseDetect(OK.replace('glibc=glibc 2.39', 'glibc=')), []), null);
});

test('noWslFix and firewallFixCommand', () => {
  assert.ok(noWslFix().startsWith('wsl --install'));
  const f = firewallFixCommand();
  assert.ok(f.includes('New-NetFirewallRule') && f.includes('5343,5344'));
  assert.ok(f.includes('vEthernet (WSL*)'));
});

test('decodeWslText: UTF-16LE with and without BOM, UTF-8 untouched', () => {
  const msg = 'Windows Subsystem for Linux has no installed distributions.\r\n';
  assert.equal(decodeWslText(utf16(msg)), msg.replace('\r', ''));
  assert.equal(decodeWslText(utf16(msg, true)), msg.replace('\r', ''));
  assert.equal(
    decodeWslText(new TextEncoder().encode('kernel=5.15\nip=1.2.3.4')),
    'kernel=5.15\nip=1.2.3.4',
  );
  assert.equal(decodeWslText(new Uint8Array(0)), '');
});

test('parseRelayLine: the run.ts lines', () => {
  const cases: Array<[string, string, string | null, string]> = [
    [
      p('WARN ', 'waiting for DeckBridge at 192.168.1.20:5343: connect ECONNREFUSED'),
      'warn',
      'blocked',
      'waiting for DeckBridge at 192.168.1.20:5343: connect ECONNREFUSED',
    ],
    [
      p('INFO ', 'dock: sn=A7F pid=0x00a5 child port 5344'),
      'info',
      'probe-ok',
      'dock: sn=A7F pid=0x00a5 child port 5344',
    ],
    [
      p('INFO ', 'listening on 0.0.0.0:5343 and :5344'),
      'info',
      'ready',
      'listening on 0.0.0.0:5343 and :5344',
    ],
    [
      p('INFO ', 'Elgato connected (main #1) from 172.28.16.1'),
      'info',
      'connected',
      'Elgato connected (main #1) from 172.28.16.1',
    ],
    [
      p('INFO ', 'main #1 closed by elgato (end) after 1.0 s, up 1 B, down 2 B'),
      'info',
      'closed',
      'main #1 closed by elgato (end) after 1.0 s, up 1 B, down 2 B',
    ],
    [
      p('WARN ', 'child #2 closed by relay (reset) after 0.1 s, up 0 B, down 0 B'),
      'warn',
      'closed',
      'child #2 closed by relay (reset) after 0.1 s, up 0 B, down 0 B',
    ],
    [
      p('ERROR', "can't listen on 0.0.0.0:5343 or :5344 (EADDRINUSE). Is DeckBridge running?"),
      'error',
      'error',
      "can't listen on 0.0.0.0:5343 or :5344 (EADDRINUSE). Is DeckBridge running?",
    ],
    [p('INFO ', 'relay → 192.168.1.20:5343'), 'info', null, 'relay → 192.168.1.20:5343'],
  ];
  for (const [line, level, event, message] of cases) {
    const r = parseRelayLine(line);
    assert.equal(r.level, level, line);
    assert.equal(r.event, event, line);
    assert.equal(r.message, message, line);
  }
});

test('parseRelayLine: unprefixed lines pass through and CR is dropped', () => {
  const r = parseRelayLine("./deckbridge: version `GLIBC_2.38' not found\r");
  assert.equal(r.level, 'info');
  assert.equal(r.event, null);
  assert.equal(r.message, "./deckbridge: version `GLIBC_2.38' not found");
  assert.equal(parseRelayLine('listening on x').event, 'ready');
});

test('zipArch, zipName and the release URLs', () => {
  assert.equal(zipArch('x86_64'), 'x86_64');
  assert.equal(zipArch('aarch64'), 'arm64');
  assert.equal(zipArch('armv7l'), null);
  assert.equal(zipName('0.23.0', 'arm64'), 'deckbridge-v0.23.0-linux-arm64.zip');
  assert.equal(
    releaseZipUrl('0.23.0', 'x86_64'),
    'https://github.com/lukasMega/DeckBridge/releases/download/deckbridge-v0.23.0/deckbridge-v0.23.0-linux-x86_64.zip',
  );
  assert.equal(
    releaseZipUrl('v0.23.0', 'arm64'),
    'https://github.com/lukasMega/DeckBridge/releases/download/deckbridge-v0.23.0/deckbridge-v0.23.0-linux-arm64.zip',
  );
  assert.equal(
    sumsUrl('0.23.0'),
    'https://github.com/lukasMega/DeckBridge/releases/download/deckbridge-v0.23.0/SHA256SUMS.txt',
  );
});

test('findSha256 picks the line of the named zip', () => {
  const h1 = 'a'.repeat(64);
  const h2 = 'B'.repeat(64);
  const sums = `${h1}  ./deckbridge-v1-windows-x86_64.zip\n${h2} *./deckbridge-v1-linux-x86_64.zip\n`;
  assert.equal(findSha256(sums, 'deckbridge-v1-linux-x86_64.zip'), 'b'.repeat(64));
  assert.equal(findSha256(sums, 'deckbridge-v1-linux-arm64.zip'), null);
  assert.equal(findSha256('', 'x.zip'), null);
});

test('isIPv4 accepts dotted quads only', () => {
  assert.equal(isIPv4('172.28.16.5'), true);
  assert.equal(isIPv4('fd00::1'), false);
  assert.equal(isIPv4('host.local'), false);
  assert.equal(isIPv4(''), false);
});

test('relayTarget: bind IP, else LAN IP; loopback and no address are errors', () => {
  assert.deepEqual(relayTarget('0.0.0.0', '192.168.1.20'), { ip: '192.168.1.20' });
  assert.deepEqual(relayTarget('10.0.0.7', '192.168.1.20'), { ip: '10.0.0.7' });
  assert.deepEqual(relayTarget('::', '192.168.1.20'), { ip: '192.168.1.20' });
  assert.deepEqual(relayTarget('127.0.0.1', '192.168.1.20'), {
    error: "DeckBridge is bound to 127.0.0.1; WSL can't reach it. Remove the bind setting.",
  });
  assert.ok('error' in relayTarget('localhost', '192.168.1.20'));
  assert.deepEqual(relayTarget('0.0.0.0', ''), { error: 'No network address found' });
});

summary();
