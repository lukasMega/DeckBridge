// Records the short settings walkthrough clips used by the docs/blog:
// home screen → cursor to the gear → open one settings section → scroll it.
//
// Not part of any suite: run it by hand against a DeckBridge already serving the
// Web UI (mock mode is fine), then commit the .webm/.mp4 it writes to docs/img/.
//
//   mise run s   # or any running DeckBridge on :3000
//   node e2e/scripts/record-ui-clips.mjs [--url http://127.0.0.1:3000]
//
// The pointer is a DOM overlay, not the real cursor: Chromium does not paint the
// system pointer into a captured video, so a scripted dot is the only way to show
// where the click lands.
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const IMG_DIR = resolve(HERE, '../../docs/img');
const URL_ARG = process.argv.indexOf('--url');
const BASE_URL = URL_ARG === -1 ? 'http://127.0.0.1:3000' : process.argv[URL_ARG + 1];
const SIZE = { width: 900, height: 720 };

const CLIPS = [
  {
    name: 'webui-diagnostics-tour',
    bodyId: '#diagnostics-body',
    section: '.diag-section',
  },
  {
    name: 'webui-device-tuning-tour',
    bodyId: '#device-tuning-body',
    section: '#device-tuning',
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Pointer overlay + the helpers the clip script drives it with. */
const POINTER_SETUP = `(() => {
  const dot = document.createElement('div');
  dot.id = '__clip_pointer';
  dot.style.cssText = [
    'position:fixed', 'left:0', 'top:0', 'width:18px', 'height:18px',
    'margin:-9px 0 0 -9px', 'border-radius:99px', 'z-index:2147483647',
    'pointer-events:none', 'background:rgba(255,255,255,0.9)',
    'box-shadow:0 0 0 2px rgba(0,0,0,0.45), 0 2px 8px rgba(0,0,0,0.4)',
    'transition:transform 0.6s cubic-bezier(0.4,0,0.2,1), left 0.6s cubic-bezier(0.4,0,0.2,1), top 0.6s cubic-bezier(0.4,0,0.2,1)',
  ].join(';');
  document.body.appendChild(dot);
  window.__clip = {
    moveTo(sel) {
      const el = document.querySelector(sel);
      const r = el.getBoundingClientRect();
      dot.style.left = r.left + r.width / 2 + 'px';
      dot.style.top = r.top + r.height / 2 + 'px';
    },
    press() {
      dot.style.transform = 'scale(0.6)';
      setTimeout(() => { dot.style.transform = 'scale(1)'; }, 180);
    },
  };
})()`;

/** The recording machine's home path and LAN address are not part of the story.
 *  A status push re-renders and would restore them, so this keeps re-applying. */
const REDACT_SETUP = `(() => {
  const scrub = (root) => {
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walk.nextNode())) {
      const next = n.nodeValue
        .replace(/\\/Users\\/[^/\\s]+\\//, '/Users/you/')
        .replace(/\\b(?:192\\.168|10|172\\.(?:1[6-9]|2\\d|3[01]))(?:\\.\\d{1,3}){2,3}\\b/, '192.168.1.42');
      if (next !== n.nodeValue) n.nodeValue = next;
    }
  };
  scrub(document.body);
  new MutationObserver(() => scrub(document.body)).observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
  });
})()`;

async function record(browser, clip) {
  const dir = mkdtempSync(join(tmpdir(), 'db-clip-'));
  const context = await browser.newContext({
    viewport: SIZE,
    deviceScaleFactor: 2,
    recordVideo: { dir, size: SIZE },
  });
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem('deckbridge.theme', 'dark'));
  await page.goto(BASE_URL);
  await page.waitForSelector('#settingsBtn');
  await page.evaluate(POINTER_SETUP);
  await page.evaluate(REDACT_SETUP);

  // Home screen, then the gear.
  await page.evaluate(() => window.__clip.moveTo('.brand-home'));
  await sleep(1200);
  await page.evaluate(() => window.__clip.moveTo('#settingsBtn'));
  await sleep(800);
  await page.evaluate(() => window.__clip.press());
  await page.click('#settingsBtn');
  await sleep(900);

  // The section header, then its body.
  const header = `${clip.section} > .collapse-header`;
  await page.evaluate((sel) => window.__clip.moveTo(sel), header);
  await sleep(800);
  await page.evaluate(() => window.__clip.press());
  await page.click(header);
  await page.waitForSelector(`${clip.bodyId}.open`);
  await sleep(1000);

  await page.evaluate(
    (sel) => document.querySelector(sel).scrollIntoView({ behavior: 'smooth', block: 'center' }),
    clip.section,
  );
  await sleep(1800);
  await page.evaluate(() => window.scrollBy({ top: 320, behavior: 'smooth' }));
  await sleep(1800);

  const video = page.video();
  await context.close();
  const webm = resolve(IMG_DIR, `${clip.name}.webm`);
  renameSync(await video.path(), webm);
  rmSync(dir, { recursive: true, force: true });

  // Safari has no webm: ship an mp4 alongside it, like the batch-transfer clip.
  const mp4 = resolve(IMG_DIR, `${clip.name}.mp4`);
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-i',
      webm,
      '-movflags',
      'faststart',
      '-pix_fmt',
      'yuv420p',
      '-vf',
      'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v',
      'libx264',
      '-crf',
      '28',
      mp4,
    ],
    { stdio: 'ignore' },
  );
  console.log(`wrote ${clip.name}.webm + .mp4`);
}

const browser = await chromium.launch();
try {
  for (const clip of CLIPS) await record(browser, clip);
} finally {
  await browser.close();
}
console.log(
  readdirSync(IMG_DIR)
    .filter((f) => f.includes('tour'))
    .join('\n'),
);
