import assert from 'tjs:assert';
import { relayScript } from '../src/web/server/relay-script.js';
import { platformName } from '../src/infra/os-utils.js';
import { deviceScript } from '../src/web/server/relay-script-device.js';
import { test, testAsync, summaryExit } from './helpers/harness.js';

/* eslint-disable sonarjs/no-hardcoded-ip -- fixture address, nothing is contacted */
console.log('\nrelay install script');

const P = { version: 'v0.23.0', target: '192.168.2.212', targetPort: 5343 };

test('script bakes version, target and port; runs everything from main()', () => {
  const s = relayScript(P);
  assert.ok(s.startsWith('#!/bin/sh\n'));
  assert.ok(s.includes("VERSION='0.23.0'"));
  assert.ok(s.includes("TARGET='192.168.2.212'"));
  assert.ok(s.includes("TARGET_PORT='5343'"));
  assert.ok(s.includes('/deckbridge-v0.23.0'));
  assert.ok(s.includes('sha256sum -c'));
  assert.ok(s.trimEnd().endsWith('main "$@"'));
});

test('arch is detected in the VM, not baked in', () => {
  const s = relayScript(P);
  assert.ok(s.includes('x86_64 | amd64) arch=x86_64'));
  assert.ok(s.includes('aarch64 | arm64) arch=arm64'));
  assert.ok(s.includes('linux-${arch}.zip'));
});

test('a value that could inject shell is refused', () => {
  assert.throws(() => relayScript({ ...P, version: "1.0.0'; rm -rf ~; '" }));
  assert.throws(() => relayScript({ ...P, target: '1.2.3.4; id' }));
  assert.throws(() => relayScript({ ...P, targetPort: 0 }));
});

const D = { ...P, scriptPort: 44661, token: 'ab12'.repeat(8) };

test('both scripts move the files out of the release zip folder', () => {
  assert.ok(relayScript(P).includes('cp -R "deckbridge-v${VERSION}-linux-${arch}"/. .'));
  assert.ok(deviceScript(D).includes('cp -R "$inner"/. .'));
});

test('device script bakes values and runs everything from main()', () => {
  const s = deviceScript(D);
  assert.ok(s.startsWith('#!/bin/sh\n'));
  assert.ok(s.includes("VERSION='0.23.0'"));
  assert.ok(s.includes("EVENT_URL='http://192.168.2.212:44661/relay/event'"));
  assert.ok(s.includes(`TOKEN='${D.token}'`));
  assert.ok(s.includes('--no-advertise'));
  assert.ok(s.trimEnd().endsWith('main "$@"'));
});

test('device script covers platforms, glibc, checksum, unzip fallbacks and uninstall', () => {
  const s = deviceScript(D);
  for (const part of [
    'Darwin)',
    'Linux)',
    'getconf GNU_LIBC_VERSION',
    'shasum -a 256',
    'sha256sum',
    'bsdtar -xf',
    'python3 -m zipfile',
    'wget',
    '--uninstall',
    'glibc $glibc; the relay needs 2.38+',
  ]) {
    assert.ok(s.includes(part), part);
  }
  for (const stage of ['downloading', 'installing', 'starting', 'running', 'failed']) {
    assert.ok(s.includes(`event ${stage}`), stage);
  }
});

test('device script refuses a value that could inject shell', () => {
  assert.throws(() => deviceScript({ ...D, version: "1.0.0'; id; '" }));
  assert.throws(() => deviceScript({ ...D, target: '1.2.3.4; id' }));
  assert.throws(() => deviceScript({ ...D, token: 'x'.repeat(32) }));
  assert.throws(() => deviceScript({ ...D, token: "a'; id; '".padEnd(32, 'a') }));
  assert.throws(() => deviceScript({ ...D, scriptPort: 70_000 }));
});

async function run(argv: string[], stdin: string): Promise<{ code: number; out: string }> {
  const proc = tjs.spawn(argv, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const w = proc.stdin!.getWriter();
  await w.write(new TextEncoder().encode(stdin));
  await w.close();
  const out = await new Response(proc.stdout as ReadableStream).text();
  const { exit_status } = await proc.wait();
  return { code: exit_status, out };
}

const hasSh = platformName() !== 'Windows';

await testAsync('the checksum lookup finds a ./name entry in the release list', async () => {
  if (!hasSh) return;
  const zip = 'deckbridge-v0.23.0-linux-arm64.zip';
  const line = deviceScript(D)
    .split('\n')
    .find((l) => l.includes('want=$(awk'))!
    .trim();
  const sums = 'aaa  ./other.zip\nabc123  ./' + zip + '\n';
  const file = `sums-${tjs.pid}.txt`;
  const lookup = line.replace('SHA256SUMS.txt', file);
  const sh = `zip=${zip}\nprintf '${sums.replaceAll('\n', '\\n')}' > /tmp/${file}\ncd /tmp && ${lookup}\necho "$want"`;
  const r = await run(['sh'], sh);
  assert.equal(r.out.trim(), 'abc123');
});

await testAsync('both scripts pass sh -n', async () => {
  if (!hasSh) return;
  for (const s of [relayScript(P), deviceScript(D)]) {
    const r = await run(['sh', '-n'], s);
    assert.equal(r.code, 0, r.out);
  }
});

await testAsync('device script passes shellcheck when installed', async () => {
  if (!hasSh) return;
  let r;
  try {
    r = await run(['shellcheck', '-s', 'sh', '-'], deviceScript(D));
  } catch {
    return; // not installed
  }
  assert.equal(r.code, 0, r.out);
});

summaryExit();
