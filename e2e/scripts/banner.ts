// Regenerate the 1280×640 social banner (GitHub social preview) around a fresh WebUI capture.
// `mise run banner [-- --icons-from=http://127.0.0.1:3000]`
// Key icons come from a running DeckBridge (a new WS client gets the selected dock's frames);
// with none reachable, built-in icons stand in. Output: docs-site/static/img/social-banner.png.
import assert from 'node:assert/strict';
import { connect, type Socket } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import { startAppServer } from '../helpers/app-server.ts';
import { waitFor } from '../helpers/ports.ts';

interface KeyImage {
  mk2Index: number;
  data: string;
  format: 'jpeg' | 'bmp';
}

const root = resolve(import.meta.dirname, '../..');
const out = join(root, 'docs-site/static/img/social-banner.png');
const iconsFrom =
  process.argv.find((a) => a.startsWith('--icons-from='))?.slice(13) ?? 'http://127.0.0.1:3000';
const version = JSON.parse(readFileSync(join(root, 'ts/package.json'), 'utf8')).version;
const MK2_KEYS = 15;

/** Key images the running app currently shows; [] when nothing answers. */
function liveIcons(url: string): Promise<KeyImage[]> {
  const icons = new Map<number, KeyImage>();
  return new Promise((done) => {
    let ws: WebSocket;
    const finish = () => {
      clearTimeout(guard);
      ws.close();
      done([...icons.values()].filter((i) => i.mk2Index < MK2_KEYS));
    };
    const guard = setTimeout(finish, 3000);
    try {
      ws = new WebSocket(`${url.replace(/^http/, 'ws')}/api/ws`);
    } catch {
      clearTimeout(guard);
      return done([]);
    }
    ws.onerror = finish;
    ws.onmessage = (e) => {
      const { event, data } = JSON.parse(String(e.data)) as { event: string; data: KeyImage };
      if (event === 'image') icons.set(data.mk2Index, data);
    };
    // The snapshot is sent right after the upgrade; give it a moment to arrive.
    ws.onopen = () => {
      clearTimeout(guard);
      setTimeout(finish, 1000);
    };
  });
}

// [MK.2 index, label, gradient from, gradient to, 24×24 SVG body]
const FALLBACK: [number, string, string, string, string][] = [
  [
    0,
    'Apps',
    '#2f6bff',
    '#29b6f6',
    '<path d="M5 5h4v4H5zM10 5h4v4h-4zM15 5h4v4h-4zM5 10h4v4H5zM10 10h4v4h-4zM15 10h4v4h-4zM5 15h4v4H5zM10 15h4v4h-4zM15 15h4v4h-4z"/>',
  ],
  [
    1,
    'Links',
    '#2f6bff',
    '#29b6f6',
    '<circle cx="12" cy="12" r="8" fill="none" stroke="#fff" stroke-width="2"/><path d="M4 12h16M12 4c3 3 3 13 0 16M12 4c-3 3-3 13 0 16" fill="none" stroke="#fff" stroke-width="2"/>',
  ],
  [
    2,
    'Shot',
    '#7f7fff',
    '#4dd0e1',
    '<path d="M4 9V5h4M16 5h4v4M20 15v4h-4M8 19H4v-4" fill="none" stroke="#fff" stroke-width="2"/><circle cx="12" cy="12" r="3"/>',
  ],
  [5, 'Learn', '#2f6bff', '#29b6f6', '<path d="M2 10l10-5 10 5-10 5zM6 12v4c3 3 9 3 12 0v-4"/>'],
  [
    6,
    'Emojis',
    '#2f6bff',
    '#29b6f6',
    '<circle cx="12" cy="12" r="8" fill="none" stroke="#fff" stroke-width="2"/><circle cx="9" cy="10" r="1.3"/><circle cx="15" cy="10" r="1.3"/><path d="M8 14c2 3 6 3 8 0" fill="none" stroke="#fff" stroke-width="2"/>',
  ],
  [
    7,
    'Record',
    '#7f7fff',
    '#4dd0e1',
    '<path d="M4 9V5h4M16 5h4v4M20 15v4h-4M8 19H4v-4" fill="none" stroke="#fff" stroke-width="2"/><circle cx="12" cy="12" r="3.5" fill="#ff3b30"/>',
  ],
  [
    10,
    'Mute',
    '#c837ff',
    '#ff4f8b',
    '<path d="M3 9h4l5-4v14l-5-4H3zM15 9l6 6M21 9l-6 6" stroke="#fff" stroke-width="2"/>',
  ],
  [
    11,
    'Vol −',
    '#ff5f6d',
    '#ffc371',
    '<path d="M5 9h4l5-4v14l-5-4H5zM17 9c1.5 1.5 1.5 4.5 0 6" stroke="#fff" stroke-width="2" fill-rule="evenodd"/>',
  ],
  [
    12,
    'Vol +',
    '#12c2e9',
    '#5ee7a0',
    '<path d="M3 9h4l5-4v14l-5-4H3z"/><path d="M15 9c1.5 1.5 1.5 4.5 0 6M18 6c3 3 3 9 0 12" fill="none" stroke="#fff" stroke-width="2"/>',
  ],
  [
    14,
    'Next',
    '#8e8e93',
    '#8e8e93',
    '<rect x="4" y="4" width="16" height="16" rx="2" fill="none" stroke="#fff" stroke-width="2"/><path d="M10 8l4 4-4 4" fill="none" stroke="#fff" stroke-width="2"/>',
  ],
];

/** Render the stand-in icons as the 144 px JPEGs the Elgato app would send: upside down,
 *  since MK.2 wire images are rotated 180° and the preview undoes it. */
async function fallbackIcons(browser: Browser): Promise<KeyImage[]> {
  const page = await browser.newPage({ viewport: { width: 144, height: 144 } });
  const icons: KeyImage[] = [];
  try {
    for (const [mk2Index, label, from, to, svg] of FALLBACK) {
      await page.setContent(
        `<body style="margin:0;width:144px;height:144px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;transform:rotate(180deg);background:linear-gradient(135deg,${from},${to});font:600 22px -apple-system,'Helvetica Neue',Arial,sans-serif;color:#fff">` +
          `<svg width="72" height="72" viewBox="0 0 24 24" fill="#fff">${svg}</svg>${label}</body>`,
      );
      const jpeg = await page.screenshot({ type: 'jpeg', quality: 90 });
      icons.push({ mk2Index, data: jpeg.toString('base64'), format: 'jpeg' });
    }
  } finally {
    await page.close();
  }
  return icons;
}

/** The light-theme WebUI card, paired and showing `icons` in the live preview (PNG, 2×). */
async function captureApp(browser: Browser, baseURL: string, icons: KeyImage[]): Promise<Buffer> {
  const context = await browser.newContext({
    viewport: { width: 500, height: 1200 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
  });
  try {
    await context.addInitScript(() => localStorage.setItem('deckbridge.theme', 'light'));
    // The capture machine's Stream Deck app version must not show up in a published image.
    await context.route('**/api/pairing-route', (route) => route.fulfill({ json: null }));
    await context.routeWebSocket('**/api/ws', (ws) => {
      const server = ws.connectToServer();
      server.onMessage((m) => ws.send(m));
      ws.onMessage((m) => server.send(m));
      // After the page's `open` handler has cleared its previews.
      setTimeout(() => {
        for (const icon of icons) ws.send(JSON.stringify({ event: 'image', data: icon }));
      }, 300);
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(baseURL, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Connected', exact: true }).waitFor();
    await page.waitForFunction(
      (n) => document.querySelectorAll('#stage .key-grid img').length >= n,
      icons.length,
    );
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator('.app-version').textContent(), `v${version}`);
    assert.equal(await page.locator('#advancedBtn').count(), 0, 'needs a simple-only mock build');
    // Transparent page so the card's rounded corners stay clean on the banner gradient.
    // CSSOM, not a <style> tag: the WebUI's CSP blocks inline styles.
    await page.evaluate(() => {
      for (const el of [document.documentElement, document.body]) {
        el.style.setProperty('background', 'transparent', 'important');
      }
    });
    const png = await page
      .locator('.app')
      .screenshot({ animations: 'disabled', omitBackground: true });
    assert.deepEqual(errors, []);
    return png;
  } finally {
    await context.close();
  }
}

const LOGO =
  '<svg width="64" height="64" viewBox="0 0 16 16" fill="#3d63dd"><rect x="1" y="5" width="5" height="6" rx="1.8"/><rect x="10" y="5" width="5" height="6" rx="1.8"/><rect x="5" y="7" width="6" height="2"/></svg>';

function bannerHtml(appPng: Buffer): string {
  return `<!doctype html><html><head><style>
  body{margin:0}
  .b{box-sizing:border-box;width:1280px;height:640px;padding:0 62px 0 98px;display:flex;align-items:center;justify-content:space-between;
     background:linear-gradient(120deg,#5a9cf4 0%,#4a7fe8 55%,#3653cf 100%);color:#fff;
     font-family:-apple-system,'SF Pro Display','Helvetica Neue',Arial,sans-serif}
  .brand{display:flex;align-items:center;gap:30px;margin-left:-2px}
  .logo{width:104px;height:104px;border-radius:24px;background:#f7f9ff;display:grid;place-items:center}
  h1{margin:0;font-size:76px;font-weight:700;letter-spacing:-1.5px}
  .lead{margin:42px 0 52px;font-size:30px;line-height:42px;max-width:580px;opacity:.95}
  ul{margin:0;padding:0;list-style:none;font-size:22px;line-height:40px;opacity:.9}
  .url{margin-top:30px;font-size:20px;opacity:.6}
  .app{width:380px;filter:drop-shadow(0 18px 40px rgba(20,30,90,.35))}
</style></head><body><div class="b">
  <div>
    <div class="brand"><div class="logo">${LOGO}</div><h1>DeckBridge</h1></div>
    <p class="lead">Use a USB Stream Deck with the Elgato app — over your local network.</p>
    <ul><li>No Elgato Network Dock needed</li><li>One binary, under 5 MB, no Node.js</li><li>Mirabox · Ajazz · Elgato · Fifine · more</li></ul>
    <div class="url">github.com/lukasMega/DeckBridge</div>
  </div>
  <img class="app" src="data:image/png;base64,${appPng.toString('base64')}">
</div></body></html>`;
}

const app = await startAppServer();
let browser: Browser | undefined;
let socket: Socket | undefined;
try {
  browser = await chromium.launch({
    executablePath:
      process.env.CHROME_BIN ??
      (process.platform === 'darwin'
        ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        : undefined),
  });
  let icons = await liveIcons(iconsFrom);
  console.log(
    icons.length > 0
      ? `${icons.length} key icons from ${iconsFrom}`
      : `no icons at ${iconsFrom}, using built-in ones`,
  );
  if (icons.length === 0) icons = await fallbackIcons(browser);

  // A silent client on the child port is what the Elgato app looks like to the server.
  const s = connect({ host: '127.0.0.1', port: app.childPort });
  socket = s;
  s.on('data', () => {});
  await new Promise((done, fail) => {
    s.once('connect', done);
    s.once('error', fail);
  });
  await waitFor(
    async () => (await (await fetch(`${app.baseURL}/api/state`)).json()).elgatoConnected,
    { timeoutMs: 10000, what: 'mock pairing' },
  );

  const appPng = await captureApp(browser, app.baseURL, icons);
  const page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
  await page.setContent(bannerHtml(appPng), { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  writeFileSync(out, await page.screenshot());
  console.log(`wrote ${out}`);
} finally {
  socket?.destroy();
  await browser?.close();
  await app.stop();
}
