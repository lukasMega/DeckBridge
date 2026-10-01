// Throwaway helper for step 0 of .claude/plans/2026-09-30_virtual-browser-deck.md:
// three mock-backed docks with distinct identities, to test Elgato pairing limits.
// Delete with the plan's "Spike results" section once the spike is recorded.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const bundle = join(root, 'ts/dist/mock/bundle.js');
const tmp = mkdtempSync(join(tmpdir(), 'spike-docks-'));

// Distinct first 12 serial chars: the Elgato app keys devices by them.
const instances = [
  { name: 'A', webui: 3100, cora: 5343, identity: null },
  {
    name: 'B',
    webui: 3101,
    cora: 5361,
    identity: { serialNumber: 'B7FZA5190SPK01', childSerialNumber: 'B7FZA5191SPK01', macAddress: '02:00:00:00:0b:01' },
  },
  {
    name: 'C',
    webui: 3102,
    cora: 5371,
    identity: { serialNumber: 'C7FZA5190SPK01', childSerialNumber: 'C7FZA5191SPK01', macAddress: '02:00:00:00:0c:01' },
  },
];

const children = [];
const api = (inst, path, body) =>
  fetch(`http://127.0.0.1:${inst.webui}${path}`, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitFor(inst, check) {
  for (let i = 0; i < 120; i++) {
    const child = children.find((c) => c.inst === inst).proc;
    if (child.exitCode !== null) throw new Error(`instance ${inst.name} exited during setup`);
    try {
      if (await check()) return;
    } catch {
      /* server still starting */
    }
    await sleep(250);
  }
  throw new Error(`instance ${inst.name} setup timed out`);
}

function lanIp() {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) return a.address;
    }
  }
  return '<LAN IP>';
}

async function stopAll() {
  for (const { proc } of children) if (proc.exitCode === null) proc.kill('SIGTERM');
  await Promise.all(children.map(({ proc }) => (proc.exitCode === null ? new Promise((d) => proc.once('exit', d)) : null)));
  rmSync(tmp, { recursive: true, force: true });
}

try {
  for (const inst of instances) {
    const proc = spawn(
      process.env.TJS,
      ['run', bundle, '--mock', '--headless', '--no-daily-ping', '--webui-port', String(inst.webui), '--cache-dir', join(tmp, inst.name)],
      { cwd: root, stdio: 'inherit', env: { ...process.env, DECKBRIDGE_CORA_PORT: String(inst.cora) } },
    );
    children.push({ inst, proc });
  }
  const serials = [];
  for (const inst of instances) {
    await waitFor(inst, async () => (await (await api(inst, '/api/state')).json()).driverConnected);
    if (inst.identity) {
      const res = await api(inst, '/api/mock-config', inst.identity);
      if (!res.ok) throw new Error(`mock-config ${inst.name}: HTTP ${res.status}`);
    }
    const state = await (await api(inst, '/api/state')).json();
    // mockConfig is what setDeviceConfig sends on the wire; deviceIdentity is the settings one.
    serials.push(state.mockConfig?.serialNumber);
  }
  const keys = serials.map((s) => String(s).slice(0, 12));
  if (new Set(keys).size !== keys.length) throw new Error(`serial prefixes collide: ${keys.join(', ')}`);

  const ip = lanIp();
  console.log(`\nDocks up (serial prefixes ${keys.join(', ')}). Add in the Elgato app via "Add Network Device":`);
  console.log(`  A  127.0.0.1:5343   WebUI http://127.0.0.1:3100`);
  console.log(`  B  ${ip}:5361   WebUI http://127.0.0.1:3101`);
  console.log(`  C  ${ip}:5371   WebUI http://127.0.0.1:3102   (S3: 127.0.0.2:5371; S4: B via 127.0.0.1:5361)`);
  console.log(`S8 press: curl -X POST http://127.0.0.1:<webui>/api/key/0`);
  console.log('Ctrl-C stops all three and removes the temp cache dirs.');

  await new Promise((done) => {
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
} finally {
  await stopAll();
}
