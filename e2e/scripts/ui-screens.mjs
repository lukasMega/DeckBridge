// Visual baseline for the WebUI + browser deck: real Chrome over an isolated mock app.
// `mise run ui-screens -- --baseline` captures before a change; `mise run ui-screens` captures
// again and pixel-compares. Any diff is for a human to review, never to auto-accept
// (.claude/plans/2026-10-08_release-size-webui-css.md).
// Output: ts/dist/ui-screens/{baseline,current,diff}[-2x] (ts/dist is gitignored).
// Flags: --baseline            write baseline/ instead of comparing
//        --scale=2             devicePixelRatio 2 (own dirs, suffix -2x)
//        --strict              exact pixel compare (no noise allowance, see TOLERANCE/SPECKLE)
//        --only=<substring>    only screens whose name contains it (keeps the other files)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { freePort, freePortBlock, waitFor } from '../helpers/ports.ts';

const args = process.argv.slice(2);
const baselineMode = args.includes('--baseline');
const scale = Number(args.find((a) => a.startsWith('--scale='))?.slice(8) ?? 1);
// Chrome output is not bit-stable between page loads, even in one process: gradients dither by
// +-1 per channel over a few thousand pixels, and anti-aliased corners of small rounded
// controls move by up to ~60 levels on a handful of pixels (measured; neither is fixed by
// --disable-gpu, --deterministic-mode or freezing animations). So a screen counts as
// identical when its pixels differ by at most TOLERANCE levels, or by more on at most SPECKLE
// pixels. `--strict` compares exactly. Real changes (shifted borders, colours, wrapping)
// touch hundreds of pixels at once.
const STRICT = args.includes('--strict');
const TOLERANCE = STRICT
  ? 0
  : Number(args.find((a) => a.startsWith('--tolerance='))?.slice(12) ?? 2);
const SPECKLE = STRICT ? 0 : Number(args.find((a) => a.startsWith('--speckle='))?.slice(10) ?? 100);
const only = args.find((a) => a.startsWith('--only='))?.slice(7);

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

const suffix = scale === 1 ? '' : `-${scale}x`;
const outRoot = join(root, 'ts/dist/ui-screens');
const dirs = {
  baseline: join(outRoot, `baseline${suffix}`),
  current: join(outRoot, `current${suffix}`),
  diff: join(outRoot, `diff${suffix}`),
};
const writeDir = baselineMode ? dirs.baseline : dirs.current;
// A filtered run must not wipe the screens it does not touch.
for (const d of baselineMode ? [dirs.baseline] : [dirs.current, dirs.diff]) {
  if (!only) rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
}

const THEMES = ['light', 'dark'];
const WIDTHS = [1280, 480, 380, 240];
// Dialogs are shot at the viewport (what a user sees), pages full length.
const VIEW_HEIGHT = 900;
// Machine-specific values would make baselines non-reproducible; these are pinned.
const NEUTRAL_IP = '192.168.1.42';
const PIN = (text) =>
  text
    .replace(/"localIp":"[^"]*"/g, `"localIp":"${NEUTRAL_IP}"`)
    .replace(/"serverTime":"[^"]*"/g, '"serverTime":"12:00"');

// ── mock app ────────────────────────────────────────────────────────────────
const port = await freePort();
const deckPort = await freePort();
const cora = await freePortBlock(8);
const base = `http://127.0.0.1:${port}`;
const deckBase = `http://127.0.0.1:${deckPort}`;
// Fixed path: the log-file path shows up in Settings.
const work = join(tmpdir(), 'deckbridge-ui-screens');
rmSync(work, { recursive: true, force: true });
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
      DECKBRIDGE_DECK_PORT: String(deckPort),
      DECKBRIDGE_NATIVE_LIB: nativeLib,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let log = '';
let exited = false;
let spawnError;
child.stdout.on('data', (c) => (log += c));
child.stderr.on('data', (c) => (log += c));
child.on('exit', () => (exited = true));
child.on('error', (e) => (spawnError = e));

const state = async () => {
  const res = await fetch(`${base}/api/state`);
  assert.ok(res.ok, `GET /api/state: HTTP ${res.status}`);
  return res.json();
};
async function post(path, body = {}) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.ok(res.ok, `POST ${path}: HTTP ${res.status}`);
  return res;
}
const sockets = [];
/** A silent client on a dock's child port is what the Elgato app looks like to the server. */
async function pair(childPort) {
  const socket = connect({ host: '127.0.0.1', port: childPort });
  socket.on('data', () => {});
  socket.on('error', () => {});
  await new Promise((done, fail) => {
    socket.once('connect', done);
    socket.once('error', fail);
  });
  sockets.push(socket);
  await waitFor(async () => (await state()).docks.some((d) => d.elgatoConnected), {
    timeoutMs: 10000,
    what: 'mock pairing',
  });
}
async function unpairAll() {
  sockets.splice(0).forEach((s) => s.destroy());
  await waitFor(async () => (await state()).docks.every((d) => !d.elgatoConnected), {
    timeoutMs: 10000,
    what: 'unpair',
  });
}
async function useDevice(modelId) {
  await post('/api/device-model', { modelId });
  await waitFor(
    async () => {
      const s = await state();
      return s.driverConnected && s.modelId === modelId;
    },
    { timeoutMs: 10000, what: `${modelId} mock device` },
  );
}

/** Mock identities (serial, MAC) are random per run and show in Settings; seed fixed ones. */
const MOCK_DEVICES = ['mk2', 'mirabox-293s', 'ajazz-akp05e'];
async function seedIdentities() {
  await post('/api/settings', {
    devices: MOCK_DEVICES.map((id, i) => ({
      deviceKey: `mock:${id}`,
      mdnsServiceName: 'Network Stream Deck',
      macAddress: `02:00:00:00:00:0${i + 1}`,
      dockSerial: `A7FZA519${i}AAAAA`,
      childSerial: `A7FZA519${i}BBBBB`,
    })),
  });
  // Identities apply when a device opens: leave the one opened at startup and come back.
  await useDevice('mirabox-293s');
}

// ── key frames the page would get from the Elgato app ───────────────────────
const FRAME_PX = 96;
function frameBmp(index) {
  const stride = FRAME_PX * 3;
  const buf = Buffer.alloc(54 + stride * FRAME_PX);
  buf.write('BM');
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(FRAME_PX, 18);
  buf.writeInt32LE(FRAME_PX, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(stride * FRAME_PX, 34);
  const tint = [(index * 53) % 200, (index * 97) % 200, (index * 29) % 200];
  for (let y = 0; y < FRAME_PX; y++) {
    for (let x = 0; x < FRAME_PX; x++) {
      const stripe = ((x + y) >> 3) & 1 ? 40 : 0;
      const box = x > 24 && x < 72 && y > 24 && y < 72 ? 90 : 0;
      const at = 54 + (FRAME_PX - 1 - y) * stride + x * 3;
      for (let c = 0; c < 3; c++) buf[at + 2 - c] = Math.min(255, 30 + tint[c] + stripe + box);
    }
  }
  return buf.toString('base64');
}
const FRAMES = Array.from({ length: 15 }, (_, i) => frameBmp(i));
// Set per screen: how many keys the next page load should receive (0 = none, like no app).
let frameCount = 0;

// ── browser plumbing ────────────────────────────────────────────────────────
const problems = [];
const results = [];

async function newPage(browser, theme, width) {
  const context = await browser.newContext({
    viewport: { width, height: VIEW_HEIGHT },
    deviceScaleFactor: scale,
    colorScheme: theme,
  });
  // Mid-flight transitions/animations are the main source of run-to-run pixel noise.
  await context.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent =
        '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';
      document.head.append(style);
    });
  });
  // Opaque origins (about:blank) deny storage.
  await context.addInitScript((t) => {
    try {
      localStorage.setItem('deckbridge.theme', t);
    } catch {}
  }, theme);
  await context.route(/\/api\/(state|standby)$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch();
    return route.fulfill({ response: res, body: PIN(await res.text()) });
  });
  // Host-dependent lookups, replaced with fixed answers.
  await context.route('**/api/elgato-app/status', (route) =>
    route.fulfill({ json: { running: false, supported: true } }),
  );
  await context.route('**/api/pairing-addresses', (route) =>
    route.fulfill({
      json: {
        platform: 'macos',
        suggested: '127.0.0.3',
        candidates: [
          { ip: '127.0.0.3', kind: 'loopback' },
          { ip: NEUTRAL_IP, kind: 'lan' },
        ],
        docks: [
          { index: 0, name: 'Mirabox 293S Stream Deck', primaryPort: 5343, running: true },
          { index: 3, name: 'Browser deck (MK.2 layout)', primaryPort: 5349, running: true },
        ],
        bindAddress: '127.0.0.1',
      },
    }),
  );
  await context.routeWebSocket('**/api/ws', (ws) => {
    const server = ws.connectToServer();
    const frames = FRAMES.slice(0, frameCount);
    server.onMessage((m) => ws.send(typeof m === 'string' ? PIN(m) : m));
    ws.onMessage((m) => server.send(m));
    // After the page's `open` handler has cleared its previews.
    if (frames.length > 0) {
      setTimeout(() => {
        frames.forEach((data, i) =>
          ws.send(JSON.stringify({ event: 'image', data: { mk2Index: i, data, format: 'bmp' } })),
        );
      }, 300);
    }
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => problems.push(String(e)));
  return { context, page };
}

/** Wait until layout is final: fonts loaded, images decoded, two frames painted. */
async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      [...document.images].map((img) => (img.complete ? null : img.decode().catch(() => {}))),
    );
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}

async function shoot(page, name, theme, width, { full = true } = {}) {
  await settle(page);
  const file = `${name}.${theme}.${width}.png`;
  const png = await page.screenshot({ animations: 'disabled', caret: 'hide', fullPage: full });
  writeFileSync(join(writeDir, file), png);
  results.push(file);
}

/** Load the WebUI; `frames` = key images the (absent) Elgato app would have sent. */
async function open(page, { frames = 0 } = {}) {
  frameCount = frames;
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('#stage').waitFor();
  if (frames > 0) {
    await page.waitForFunction(
      (n) => document.querySelectorAll('#stage .key-grid img').length >= n,
      frames,
    );
  }
}

async function openSettings(page, opts) {
  await open(page, opts);
  await page.locator('#settingsBtn').click();
  await page.locator('.help h1', { hasText: 'Settings' }).waitFor();
}

async function openTuning(page, opts) {
  await openSettings(page, opts);
  await page.locator('#stage .collapse-header', { hasText: 'Device tuning' }).click();
  await page.locator('#device-tuning .collapse-body.open').waitFor();
}

async function expandAll(page) {
  const collapsed = page.locator('#stage .collapse-header.collapsed');
  // Nested sections appear as their parent opens, so re-count every round.
  for (let round = 0; round < 50 && (await collapsed.count()) > 0; round++) {
    await collapsed.first().click();
  }
}

// ── screens ─────────────────────────────────────────────────────────────────
// Each phase arranges server state once; every screen then runs in every theme x width.
const FRAMES_ALL = { frames: 15 };
const phases = [
  {
    name: 'mk2, no Elgato app',
    arrange: async () => {
      await unpairAll();
      await useDevice('mk2');
    },
    screens: {
      'main-pairing': async (page, shot) => {
        await open(page);
        await page
          .getByRole('heading', { name: 'Connect your control app', exact: true })
          .waitFor();
        await shot();
      },
      'help-network-device': async (page, shot) => {
        await open(page);
        await page.getByRole('button', { name: 'No', exact: true }).click();
        await page.locator('button[data-help="network-device"]').click();
        await page.locator('.help h1').waitFor();
        await shot();
      },
      about: async (page, shot) => {
        await open(page);
        await page.locator('#aboutBtn').click();
        await page.locator('.popover').waitFor();
        await shot({ full: false });
      },
      settings: async (page, shot) => {
        await openSettings(page);
        await shot();
      },
      'settings-expanded': async (page, shot) => {
        await openSettings(page);
        await expandAll(page);
        await shot();
      },
      'image-fit-help': async (page, shot) => {
        await openTuning(page);
        await page.locator('#image-fit-help-btn').click();
        await page.locator('#image-fit-help').waitFor();
        await shot({ full: false });
      },
      'crop-editor': async (page, shot) => {
        await openTuning(page, FRAMES_ALL);
        await page.locator('#crop-open').click();
        await page.locator('#image-crop-editor').waitFor();
        await page.locator('#image-crop-editor canvas').first().waitFor();
        await shot({ full: false });
      },
      'crop-editor-no-frames': async (page, shot) => {
        await openTuning(page);
        await page.locator('#crop-open').click();
        await page.locator('#crop-no-frames').waitFor();
        await shot({ full: false });
      },
    },
  },
  {
    name: 'Mirabox 293S paired, side keys',
    arrange: async () => {
      await useDevice('mirabox-293s');
      await post('/api/extra-key', { wireId: 16, widget: 'text', param: 'Hello' });
      await post('/api/extra-key', { wireId: 17, widget: 'text', param: 'Deck' });
      await pair(cora + 1);
    },
    screens: {
      'main-ready': async (page, shot) => {
        await open(page, FRAMES_ALL);
        await page.getByRole('button', { name: 'Top text style' }).waitFor();
        await shot();
      },
      'xkey-text-size-popover': async (page, shot) => {
        await open(page, FRAMES_ALL);
        await page.getByRole('button', { name: /Top text size previews/ }).click();
        await page.locator('.xkey-size-thumb').first().waitFor();
        await shot({ full: false });
      },
      'xkey-text-style-popover': async (page, shot) => {
        await open(page, FRAMES_ALL);
        await page.getByRole('button', { name: 'Top text style' }).click();
        await page.locator('.xkey-popover').waitFor();
        await shot({ full: false });
      },
      'side-keys-help': async (page, shot) => {
        await open(page, FRAMES_ALL);
        await page.getByRole('button', { name: 'Side keys help' }).click();
        await page.locator('#side-keys-help-title').waitFor();
        await shot({ full: false });
      },
    },
  },
  {
    name: 'AJAZZ AKP05E paired, strip + knobs',
    arrange: async () => {
      await unpairAll();
      await useDevice('ajazz-akp05e');
      // Empty command: the widget shows its placeholder and runs nothing.
      await post('/api/extra-key', { wireId: 15, widget: 'command', param: '', action: 'refresh' });
      await post('/api/extra-key', { wireId: 10, widget: 'text', param: 'Hi' });
      await pair(cora + 1);
    },
    screens: {
      'main-ready-akp05e': async (page, shot) => {
        await open(page, { frames: 8 });
        await page.getByRole('button', { name: /command settings/ }).waitFor();
        await shot();
      },
      'xkey-command-popover': async (page, shot) => {
        await open(page, { frames: 8 });
        await page.getByRole('button', { name: /command settings/ }).click();
        await page.locator('.xkey-popover').waitFor();
        await shot({ full: false });
      },
    },
  },
  {
    name: 'browser deck enabled (two docks)',
    arrange: async () => {
      await unpairAll();
      await useDevice('mirabox-293s');
      await post('/api/virtual-deck', { enabled: true });
      await waitFor(async () => (await state()).docks.some((d) => d.index === 3), {
        timeoutMs: 10000,
        what: 'browser deck dock',
      });
      await waitFor(
        async () => (await (await fetch(`${base}/api/virtual-deck`)).json()).listening,
        { timeoutMs: 10000, what: 'browser deck listener' },
      );
    },
    screens: {
      'main-two-docks': async (page, shot) => {
        await open(page, FRAMES_ALL);
        await page.getByRole('button', { name: 'Need another address?' }).waitFor();
        await shot();
      },
      'pairing-address-modal': async (page, shot) => {
        await open(page);
        await page.getByRole('button', { name: 'Need another address?' }).click();
        await page.locator('#address-modal').waitFor();
        await page.locator('#address-pick').waitFor();
        await shot({ full: false });
      },
      'deck-pair': async (page, shot) => {
        await page.goto(`${deckBase}/deck/`, { waitUntil: 'networkidle' });
        await page.locator('#pair-screen').waitFor();
        await shot();
      },
      'deck-paired': async (page, shot) => {
        const offer = await (await post('/api/virtual-deck/pairing')).json();
        await page.goto('about:blank');
        await page.goto(offer.qrUrl.replace(/^https?:\/\/[^/]+/, deckBase), {
          waitUntil: 'networkidle',
        });
        await page.locator('.deck-key').first().waitFor();
        await shot();
        await post('/api/virtual-deck/revoke-all');
      },
    },
  },
];

// ── comparison ──────────────────────────────────────────────────────────────
/** Decodes both PNGs on a canvas in the browser, so no image library is needed. */
async function pixelDiff(page, a, b) {
  return page.evaluate(
    async ([a64, b64, tolerance]) => {
      const load = (b64) =>
        new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error('cannot decode PNG'));
          img.src = `data:image/png;base64,${b64}`;
        });
      const [ia, ib] = await Promise.all([load(a64), load(b64)]);
      const w = Math.max(ia.width, ib.width);
      const h = Math.max(ia.height, ib.height);
      const pixels = (img) => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, w, h);
      };
      const pa = pixels(ia);
      const pb = pixels(ib);
      const out = new ImageData(w, h);
      let diff = 0;
      let noise = 0;
      let maxDelta = 0;
      const hist = [0, 0, 0, 0, 0, 0]; // deltas 1, 2, 3-4, 5-8, 9-16, 17+
      let [x0, y0, x1, y1] = [w, h, -1, -1];
      for (let i = 0; i < pa.data.length; i += 4) {
        let delta = 0;
        for (let c = 0; c < 4; c++)
          delta = Math.max(delta, Math.abs(pa.data[i + c] - pb.data[i + c]));
        const px = (i / 4) % w;
        const py = Math.floor(i / 4 / w);
        if (delta <= tolerance) {
          const grey = (pa.data[i] + pa.data[i + 1] + pa.data[i + 2]) / 3;
          out.data.set([grey, grey, grey, 70], i);
          if (delta > 0) noise++;
          continue;
        }
        diff++;
        hist[delta <= 2 ? delta - 1 : delta <= 4 ? 2 : delta <= 8 ? 3 : delta <= 16 ? 4 : 5]++;
        maxDelta = Math.max(maxDelta, delta);
        [x0, y0, x1, y1] = [Math.min(x0, px), Math.min(y0, py), Math.max(x1, px), Math.max(y1, py)];
        out.data.set([255, 0, 160, 255], i);
      }
      let png64 = '';
      if (diff > 0) {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        c.getContext('2d').putImageData(out, 0, 0);
        png64 = c.toDataURL('image/png').split(',')[1];
      }
      return {
        diff,
        noise,
        hist,
        maxDelta,
        bbox: [x0, y0, x1, y1],
        sizeA: [ia.width, ia.height],
        sizeB: [ib.width, ib.height],
        png64,
      };
    },
    [a.toString('base64'), b.toString('base64'), TOLERANCE],
  );
}

async function compare(browser) {
  const page = await browser.newPage();
  await page.goto('about:blank');
  const byScreen = new Map();
  const files = only
    ? results
    : [...new Set([...results, ...readdirSync(dirs.baseline).filter((f) => f.endsWith('.png'))])];
  let differing = 0;
  for (const file of files.toSorted()) {
    const screen = file.split('.')[0];
    const line = byScreen.get(screen) ?? { total: 0, same: 0, noisy: 0, notes: [] };
    byScreen.set(screen, line);
    line.total++;
    rmSync(join(dirs.diff, file), { force: true });
    const basePath = join(dirs.baseline, file);
    const curPath = join(dirs.current, file);
    if (!existsSync(basePath) || !existsSync(curPath)) {
      line.notes.push(`${file}: missing in ${existsSync(basePath) ? 'current' : 'baseline'}`);
      differing++;
      continue;
    }
    const [a, b] = [readFileSync(basePath), readFileSync(curPath)];
    if (a.equals(b)) {
      line.same++;
      continue;
    }
    const d = await pixelDiff(page, a, b);
    if (d.diff <= SPECKLE && d.sizeA.join() === d.sizeB.join()) {
      line.same++; // PNG bytes differ, decoded pixels differ only by rendering noise
      line.noisy++;
      continue;
    }
    differing++;
    writeFileSync(join(dirs.diff, file), Buffer.from(d.png64, 'base64'));
    const pct = (
      (d.diff / (Math.max(d.sizeA[0], d.sizeB[0]) * Math.max(d.sizeA[1], d.sizeB[1]))) *
      100
    ).toFixed(3);
    const size =
      d.sizeA.join() === d.sizeB.join()
        ? ''
        : ` size ${d.sizeA.join('x')} -> ${d.sizeB.join('x')},`;
    line.notes.push(
      `${file}: ${d.diff} px (${pct}%),${size} max delta ${d.maxDelta} [1,2,3-4,5-8,9-16,17+: ${d.hist.join(' ')}], bbox ${d.bbox.join(',')}`,
    );
  }
  await page.close();
  for (const [screen, l] of byScreen) {
    const noisy = l.noisy ? ` (${l.noisy} within rendering noise)` : '';
    console.log(`${screen.padEnd(26)} ${l.same}/${l.total} identical${noisy}`);
    l.notes.forEach((n) => console.log(`    DIFF ${n}`));
  }
  const total = [...byScreen.values()].reduce((s, l) => s + l.total, 0);
  console.log(
    `\n${total} screens compared, ${differing} differ${differing ? ` (diff images: ${dirs.diff})` : ''}.`,
  );
  return differing;
}

// ── run ─────────────────────────────────────────────────────────────────────
let browser;
let differing = 0;
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

  await seedIdentities();
  for (const phase of phases) {
    const names = Object.keys(phase.screens).filter((n) => !only || n.includes(only));
    if (names.length === 0) continue;
    console.log(`phase: ${phase.name}`);
    await phase.arrange();
    for (const theme of THEMES) {
      for (const width of WIDTHS) {
        const { context, page } = await newPage(browser, theme, width);
        try {
          for (const name of names) {
            await phase.screens[name](page, (opts) => shoot(page, name, theme, width, opts));
          }
        } finally {
          await context.close();
        }
      }
    }
  }
  assert.ok(results.length > 0, `no screen matched --only=${only}`);
  assert.deepEqual(problems, [], 'page errors while capturing');
  console.log(`captured ${results.length} screens -> ${writeDir}\n`);
  if (!baselineMode) differing = await compare(browser);
} finally {
  sockets.forEach((s) => s.destroy());
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
if (differing > 0) process.exit(1);
