/* eslint-disable sonarjs/no-hardcoded-ip -- fixture addresses, nothing is contacted */
import assert from 'tjs:assert';
import { isMockPairingScenario, mockProbe } from '../src/infra/pairing-probe-mock.js';
import { macOsAtLeast, parseMacVersion, parseWslList } from '../src/infra/pairing-probe-parse.js';
import { probePairing } from '../src/infra/pairing-probe.js';
import type { ProbeRunner } from '../src/infra/pairing-probe.js';
import { testAsync, test, summary } from './helpers/harness.js';

console.log('\npairing probe');

const WSL_TABLE = [
  '  NAME            STATE           VERSION',
  '* Ubuntu-24.04    Running         2',
  '  Debian          Stopped         1',
  '',
].join('\r\n');

function utf16(s: string, bom = true): Uint8Array {
  const out = new Uint8Array((s.length + (bom ? 1 : 0)) * 2);
  let at = 0;
  for (const ch of (bom ? '﻿' : '') + s) {
    const c = ch.charCodeAt(0);
    out[at++] = c & 0xff;
    out[at++] = c >> 8;
  }
  return out;
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

test('parseWslList: default marker, v1/v2', () => {
  const r = parseWslList(WSL_TABLE);
  assert.deepEqual(r, {
    installed: true,
    distros: [
      { name: 'Ubuntu-24.04', version: 2, isDefault: true },
      { name: 'Debian', version: 1, isDefault: false },
    ],
  });
});

test('parseWslList: empty and message-only output is not installed', () => {
  const none = { installed: false, distros: [] };
  assert.deepEqual(parseWslList(''), none);
  assert.deepEqual(
    parseWslList('Windows Subsystem for Linux has no installed distributions.\n'),
    none,
  );
  assert.deepEqual(parseWslList('  NAME  STATE  VERSION\n'), none);
});

test('parseWslList: skips Docker Desktop distros', () => {
  const r = parseWslList('* docker-desktop       Running  2\n  docker-desktop-data  Stopped  2\n');
  assert.deepEqual(r, { installed: false, distros: [] });
});

test('parseWslList: localized header still parses', () => {
  const r = parseWslList('  NOM    ÉTAT      VERSION\n* Debian  Running   2\n');
  assert.equal(r.distros[0]?.name, 'Debian');
});

await testAsync('probePairing: Windows decodes the UTF-16 table', async () => {
  const runner = fakeRunner({ 'wsl.exe -l -v': { code: 0, stdout: utf16(WSL_TABLE) } });
  const p = await probePairing(deps(runner, 'Windows'));
  assert.equal(p.platform, 'Windows');
  assert.equal(p.mac, null);
  assert.equal(p.wsl?.distros.length, 2);
  assert.equal(p.wsl?.distros[0]?.isDefault, true);
});

await testAsync(
  'probePairing: Windows error exit or missing wsl.exe is not installed',
  async () => {
    const none = { installed: false, distros: [] };
    const err = fakeRunner({ 'wsl.exe -l -v': { code: 1, stdout: utf16('no distributions 2\n') } });
    assert.deepEqual((await probePairing(deps(err, 'Windows'))).wsl, none);
    const missing = fakeRunner({});
    assert.deepEqual((await probePairing(deps(missing, 'Windows'))).wsl, none);
  },
);

await testAsync('probePairing: macOS version, arch and installed runtimes', async () => {
  const runner = fakeRunner(
    {
      'sw_vers -productVersion': { code: 0, stdout: utf8('26.1\n') },
      'uname -m': { code: 0, stdout: utf8('arm64\n') },
    },
    ['/Users/me/.orbstack/bin/orb', '/usr/local/bin/container'],
  );
  const p = await probePairing({ ...deps(runner, 'macOS'), home: '/Users/me' });
  assert.equal(p.platform, 'macOS');
  assert.equal(p.wsl, null);
  assert.deepEqual(p.mac, {
    version: '26.1',
    arch: 'arm64',
    orbstack: true,
    container: true,
  });
});

await testAsync('probePairing: macOS app bundle counts as OrbStack; Intel arch', async () => {
  const runner = fakeRunner(
    {
      'sw_vers -productVersion': { code: 0, stdout: utf8('15.6\n') },
      'uname -m': { code: 0, stdout: utf8('x86_64\n') },
    },
    ['/Applications/OrbStack.app'],
  );
  const p = await probePairing({ ...deps(runner, 'macOS'), home: '/Users/me' });
  assert.deepEqual(p.mac, {
    version: '15.6',
    arch: 'x86_64',
    orbstack: true,
    container: false,
  });
});

await testAsync('probePairing: other platform runs nothing', async () => {
  const runner = fakeRunner({});
  const p = await probePairing(deps(runner, 'Linux'));
  assert.equal(p.platform, 'other');
  assert.equal(p.wsl, null);
  assert.equal(p.mac, null);
  assert.equal(runner.calls.length, 0);
});

await testAsync('probePairing: lanReachable follows the bind address', async () => {
  const runner = fakeRunner({});
  const loop = await probePairing({ ...deps(runner, 'Linux'), webuiBind: '127.0.0.1' });
  const lan = await probePairing({ ...deps(runner, 'Linux'), webuiBind: '0.0.0.0' });
  assert.equal(loop.lanReachable, false);
  assert.equal(lan.lanReachable, true);
  assert.equal(lan.lanIp, '192.168.1.20');
  assert.equal(lan.coraPort, 5343);
  assert.equal(lan.webuiPort, 3000);
});

await testAsync('probePairing: a throwing runner never throws', async () => {
  const boom: ProbeRunner = {
    run: () => Promise.reject(new Error('boom')),
    exists: () => Promise.reject(new Error('boom')),
  };
  const w = await probePairing(deps(boom, 'Windows'));
  assert.equal(w.wsl?.installed, false);
  const m = await probePairing(deps(boom, 'macOS'));
  assert.equal(m.mac?.version, '');
});

test('parseMacVersion and macOsAtLeast', () => {
  assert.equal(parseMacVersion('26.1\n'), '26.1');
  assert.equal(parseMacVersion('15.6.1'), '15.6.1');
  assert.equal(parseMacVersion('garbage'), '');
  assert.equal(macOsAtLeast('26.1', 26), true);
  assert.equal(macOsAtLeast('15.6', 26), false);
  assert.equal(macOsAtLeast('', 26), false);
});

test('mock scenarios', () => {
  assert.equal(isMockPairingScenario('mac-26'), true);
  assert.equal(isMockPairingScenario('nope'), false);
  assert.equal(mockProbe('mac-26').mac?.container, true);
  assert.equal(mockProbe('mac-15').mac?.orbstack, true);
  assert.equal(mockProbe('mac-intel').mac?.arch, 'x86_64');
  assert.equal(mockProbe('windows-wsl1').wsl?.distros[0]?.version, 1);
  assert.equal(mockProbe('windows-none').wsl?.installed, false);
  assert.equal(mockProbe('windows-wsl').wsl?.distros[0]?.name, 'Ubuntu-24.04');
});

function deps(runner: ProbeRunner, platform: string) {
  return {
    runner,
    platform,
    lanIp: '192.168.1.20',
    coraPort: 5343,
    webuiPort: 3000,
    relayScriptPort: 44661,
    webuiBind: '0.0.0.0',
  };
}

/** `results` is keyed by the space-joined argv; an unlisted argv is a failed spawn. */
function fakeRunner(
  results: Record<string, { code: number; stdout: Uint8Array }>,
  existing: string[] = [],
): ProbeRunner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    run(argv) {
      const key = argv.join(' ');
      calls.push(key);
      return Promise.resolve(results[key] ?? null);
    },
    exists: (path) => Promise.resolve(existing.includes(path)),
  };
}

summary();
