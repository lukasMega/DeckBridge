import assert from 'tjs:assert';
import { platformName } from '../src/infra/os-utils.js';
import { deviceScript } from '../src/web/server/relay-script-device.js';
import { test, testAsync, summaryExit } from './helpers/harness.js';

/* eslint-disable sonarjs/no-hardcoded-ip -- fixture address, nothing is contacted */
console.log('\nrelay install script');

const D = {
  version: 'v0.23.0',
  target: '192.168.2.212',
  targetPort: 5343,
  scriptPort: 44661,
  token: 'ab12'.repeat(8),
};

test('device script moves the files out of the release zip folder', () => {
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
    'hostname -I',
    '\\"selfIp\\":',
  ]) {
    assert.ok(s.includes(part), part);
  }
  for (const stage of ['downloading', 'installing', 'starting', 'running', 'failed']) {
    assert.ok(s.includes(`event ${stage}`), stage);
  }
});

test('device script has the Node.js relay branch', () => {
  const s = deviceScript(D);
  for (const part of [
    '--node) NODE=1',
    'file="deckbridge-relay-v$VERSION.mjs"',
    'download "$file"',
    'PLATFORM="node-$PLATFORM"',
    'the relay needs Node.js 20 or newer',
    'exec node ./deckbridge-relay.mjs relay "$@"',
    'exec ./deckbridge relay "$@"',
  ]) {
    assert.ok(s.includes(part), part);
  }
});

test('device script has the Apple container branch', () => {
  const s = deviceScript(D);
  for (const part of [
    '--container) CONTAINER=1',
    'container system status',
    'PLATFORM=container-linux-arm64',
    'plat=${PLATFORM#container-}',
    'dir="$dir-linux"',
    'container run -d --name "$CTR_NAME" --memory 256M -v "$DIR:/relay" ubuntu:24.04',
    '"/relay/$VERSION-linux/deckbridge" relay --target "$TARGET"',
    '--no-advertise',
    'container rm -f "$CTR_NAME"',
  ]) {
    assert.ok(s.includes(part), part);
  }
});

test('device script offers automatic start with a LaunchAgent and a systemd user unit', () => {
  const s = deviceScript(D);
  for (const part of [
    '--service) SERVICE=1',
    "SELF_URL='http://192.168.2.212:44661/relay.sh?t=" + D.token + "'",
    'Start the relay automatically after a restart? [Y/n]',
    'dev.deckbridge.relay.plist',
    '<key>RunAtLoad</key><true/>',
    'launchctl bootstrap',
    'launchctl bootout',
    'deckbridge-relay.service',
    'systemctl --user enable --now',
    'loginctl enable-linger',
  ]) {
    assert.ok(s.includes(part), part);
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
  const w = proc.stdin.getWriter();
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
  const sh = `set -- ${zip}\nprintf '${sums.replaceAll('\n', '\\n')}' > /tmp/${file}\ncd /tmp && ${lookup}\necho "$want"`;
  const r = await run(['sh'], sh);
  assert.equal(r.out.trim(), 'abc123');
});

await testAsync('device script accepts only --node and --uninstall', async () => {
  if (!hasSh) return;
  const r = await run(['sh', '-s', '--', '--bogus'], deviceScript(D));
  assert.equal(r.code, 2);
  // A fake HOME: --uninstall deletes $HOME/.deckbridge-relay.
  const home = `/tmp/relay-sh-${tjs.pid}`;
  const u = await run(
    [
      'sh',
      '-c',
      `mkdir -p ${home}/.deckbridge-relay && HOME=${home} sh -s -- --uninstall && ls -A ${home}; rm -rf ${home}`,
    ],
    deviceScript(D),
  );
  assert.equal(u.code, 0, u.out);
  assert.equal(u.out.trim(), 'DeckBridge relay removed.');
});

await testAsync('container_ip takes the first CIDR address of the inspect output', async () => {
  if (!hasSh) return;
  const script = deviceScript(D);
  const start = script.indexOf('container_ip() {');
  const fn = script.slice(start, script.indexOf('\n}\n', start) + 3);
  const ip = async (json: string): Promise<string> => {
    // A fake `container` that prints the fixture; the real function pipes its output.
    const sh = `CTR_NAME=x\ncontainer() { printf '%s' '${json}'; }\n${fn}\ncontainer_ip`;
    return (await run(['sh'], sh)).out.trim();
  };
  const net = '"networks":[{"address":"192.168.64.3/24","gateway":"192.168.64.1"}]';
  assert.equal(await ip(`[{"status":"running",${net}}]`), '192.168.64.3');
  assert.equal(
    await ip('[{"networks":[{"ipv4Address":"192.168.64.9/24","ipv4Gateway":"192.168.64.1"}]}]'),
    '192.168.64.9',
  );
  assert.equal(await ip('[{"networks":[]}]'), '');
});

await testAsync('device script passes sh -n', async () => {
  if (!hasSh) return;
  const r = await run(['sh', '-n'], deviceScript(D));
  assert.equal(r.code, 0, r.out);
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
