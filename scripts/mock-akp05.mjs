import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const base = 'http://127.0.0.1:3000';
const cacheDir = mkdtempSync(join(tmpdir(), 'deckbridge-mock-akp05-'));
const child = spawn(process.env.TJS, [
  'run', join(root, 'ts/dist/mock/bundle.js'), '--mock', '--headless', '--no-daily-ping',
  '--bind', '127.0.0.1', '--webui-port', '3000', '--cache-dir', cacheDir,
], { cwd: root, stdio: 'inherit' });
let socket;

const waitFor = async (check) => {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error('DeckBridge exited during setup');
    try { if (await check()) return; } catch { /* server still starting */ }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error('DeckBridge setup timed out');
};

const state = async () => (await (await fetch(`${base}/api/state`)).json());
const post = async (path, body) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
};

try {
  await waitFor(async () => (await state()).driverConnected);
  await post('/api/device-model', { modelId: 'ajazz-akp05' });
  await waitFor(async () => (await state()).modelId === 'ajazz-akp05');
  socket = connect({ host: '127.0.0.1', port: 5344 });
  socket.on('data', () => {});
  await new Promise((done, fail) => {
    socket.once('connect', done);
    socket.once('error', fail);
  });
  await waitFor(async () => {
    const current = await state();
    return current.elgatoConnected && current.docks?.[0]?.coraProfile === 'stream-deck-plus';
  });
  console.log(`Mock AKP05 paired as Stream Deck +: ${base}`);
  await new Promise((done) => {
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
    child.once('exit', done);
    socket.once('close', done);
  });
} finally {
  socket?.destroy();
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise((done) => child.once('exit', done));
  }
  rmSync(cacheDir, { recursive: true, force: true });
}
