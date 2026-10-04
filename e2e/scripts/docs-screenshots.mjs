// Refresh docs Web UI captures with real Chromium and an isolated mock app.
// Run `mise run docs-screenshots` from the repository root.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { freePort, freePortBlock, waitFor } from '../helpers/ports.ts';

const root = resolve(import.meta.dirname, '../..');
const bundle = join(root, 'ts/dist/mock/bundle.js');
const tjs =
  process.env.TJS ??
  join(root, `vendor/txiki.js/build/tjs${process.platform === 'win32' ? '.exe' : ''}`);
const nativeName =
  process.platform === 'win32'
    ? 'deckbridge_native.dll'
    : `libdeckbridge_native.${process.platform === 'darwin' ? 'dylib' : 'so'}`;
const nativeLib =
  process.env.DECKBRIDGE_NATIVE_LIB ?? join(root, 'rust/target/release', nativeName);
for (const file of [bundle, tjs, nativeLib]) {
  assert.ok(existsSync(file), `${file} missing — run mise run build-mock first`);
}
const version = JSON.parse(readFileSync(join(root, 'ts/package.json'), 'utf8')).version;
const port = await freePort();
const cora = await freePortBlock(8);
const base = `http://127.0.0.1:${port}`;
const work = mkdtempSync(join(tmpdir(), 'deckbridge-docs-shots-'));
const child = spawn(
  tjs,
  [
    'run',
    bundle,
    '--mock',
    '--headless',
    '--no-daily-ping',
    '--bind',
    '127.0.0.1',
    '--webui-port',
    String(port),
    '--cache-dir',
    join(work, 'cache'),
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      DECKBRIDGE_MOCK: '1',
      DECKBRIDGE_CORA_PORT: String(cora),
      DECKBRIDGE_NATIVE_LIB: nativeLib,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let log = '';
let exited = false;
let spawnError;
child.stdout.on('data', (chunk) => {
  log += chunk;
});
child.stderr.on('data', (chunk) => {
  log += chunk;
});
child.on('exit', () => {
  exited = true;
});
child.on('error', (error) => {
  spawnError = error;
});
const state = async () => {
  const response = await fetch(`${base}/api/state`);
  assert.ok(response.ok, `GET /api/state: HTTP ${response.status}`);
  return response.json();
};
let browser;
let socket;
const files = [];

async function pair() {
  socket = connect({ host: '127.0.0.1', port: cora + 1 });
  socket.on('data', () => {});
  await new Promise((done, fail) => {
    socket.once('connect', done);
    socket.once('error', fail);
  });
  await waitFor(async () => (await state()).elgatoConnected, {
    timeoutMs: 10000,
    what: 'mock pairing',
  });
}

async function capture(name, snapshot, heading, wide = false) {
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({
      viewport: { width: wide ? 1440 : 500, height: wide ? 955 : 1200 },
      deviceScaleFactor: wide ? 1 : 2,
      colorScheme: theme,
    });
    try {
      await context.addInitScript(
        (theme) => localStorage.setItem('deckbridge.theme', theme),
        theme,
      );
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      // Neutral LAN IP keeps capture-machine details out of published images.
      await page.route('**/api/state', (route) =>
        route.fulfill({ json: { ...snapshot, localIp: '192.168.1.42' } }),
      );
      // Keep staged no-device/conflict snapshots from being replaced by live mock status.
      await page.routeWebSocket('**/api/ws', () => {});
      await page.goto(base, { waitUntil: 'networkidle' });
      await page.getByRole('heading', { name: heading, exact: true }).waitFor();
      if (name === 'webui-simple' || name === 'webui-state-pairing') {
        await page.getByRole('button', { name: 'No', exact: true }).click();
      }
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
      assert.equal(await page.locator('.app-version').textContent(), `v${version}`);
      assert.equal(
        await page.locator('#advancedBtn').count(),
        0,
        'captures require a simple-only mock build',
      );
      const box = await page.locator('.app').boundingBox();
      assert.ok(box);
      const height = wide ? Math.max(955, Math.ceil(box.height + 108)) : Math.ceil(box.height + 56);
      if (wide)
        assert.equal(height, 955, 'homepage capture outgrew its 1440x955 dimensions in index.tsx');
      await page.setViewportSize({ width: wide ? 1440 : 500, height });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
        'capture has horizontal overflow',
      );
      const filename = `${name}${theme === 'dark' ? '-dark' : ''}.png`;
      await page.screenshot({ path: join(work, filename), animations: 'disabled', fullPage: true });
      assert.deepEqual(errors, []);
      files.push(filename);
      console.log(`${filename}: ${wide ? 1440 : 1000}x${height * (wide ? 1 : 2)}`);
    } finally {
      await context.close();
    }
  }
}

try {
  await waitFor(
    async () => {
      if (spawnError) throw spawnError;
      if (exited) throw new Error(`mock app exited before readiness:\n${log}`);
      try {
        return (await state()).driverConnected;
      } catch {
        return false;
      }
    },
    { timeoutMs: 30000, what: 'mock Web UI startup' },
  );
  const executablePath =
    process.env.CHROME_BIN ??
    (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : undefined);
  browser = await chromium.launch({
    executablePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const pairing = await state();
  assert.equal(pairing.modelId, 'mk2');
  await capture('webui-simple', pairing, 'Connect your control app', true);
  await capture('webui-state-pairing', pairing, 'Connect your control app');
  const absent = {
    ...pairing,
    driverMode: 'real',
    driverConnected: false,
    elgatoConnected: false,
    modelId: '',
    modelName: '',
    docks: [],
    elgatoAppConflict: false,
    elgatoDevicePresent: false,
  };
  await capture('webui-state-no-device', absent, 'Connect your device');
  await capture(
    'webui-state-conflict',
    { ...absent, elgatoAppConflict: true, elgatoDevicePresent: true },
    'Elgato app owns the USB device',
  );
  await pair();
  await capture('webui-state-ready', await state(), 'Connected');
  socket.destroy();
  await waitFor(async () => !(await state()).elgatoConnected, {
    timeoutMs: 10000,
    what: 'mock disconnection',
  });
  const response = await fetch(`${base}/api/device-model`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelId: 'ajazz-akp05' }),
  });
  assert.ok(response.ok, `POST /api/device-model: HTTP ${response.status}`);
  await waitFor(
    async () => {
      const current = await state();
      return current.driverConnected && current.modelId === 'ajazz-akp05';
    },
    { timeoutMs: 10000, what: 'AKP05 mock setup' },
  );
  await pair();
  const akp05 = await state();
  assert.equal(akp05.docks[0].coraProfile, 'stream-deck-plus');
  assert.equal(akp05.keyCount, 8);
  await capture('webui-akp05-plus', akp05, 'Connected');

  // Publish only after every capture passes; failed runs retain existing docs images.
  for (const filename of files) {
    copyFileSync(join(work, filename), join(root, 'docs/img', filename));
    if (filename.startsWith('webui-simple')) {
      copyFileSync(join(work, filename), join(root, 'docs-site/static/img', filename));
    }
  }
  console.log('Updated 12 docs screenshots and 2 homepage copies.');
} finally {
  socket?.destroy();
  try {
    await browser?.close();
  } finally {
    if (!exited && child.pid !== undefined) {
      child.kill('SIGTERM');
      await waitFor(async () => exited, { timeoutMs: 5000, what: 'mock app shutdown' }).catch(() =>
        child.kill('SIGKILL'),
      );
    }
    rmSync(work, { recursive: true, force: true });
  }
}
