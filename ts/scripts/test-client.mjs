// Real Preact/DOM regression checks. Requires Chrome or CHROME_BIN.
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const temp = mkdtempSync(join(tmpdir(), 'deckbridge-client-test-'));
const chrome =
  process.env.CHROME_BIN ??
  (process.platform === 'darwin' &&
  existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : 'google-chrome');
/** @type {import('node:child_process').ChildProcess | null} */
let browser = null;
try {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../test/client-regressions.tsx', import.meta.url))],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    jsxImportSource: 'preact',
  });
  const html = join(temp, 'test.html');
  writeFileSync(
    html,
    '<!doctype html><html><body><script>' +
      bundle.outputFiles[0].text.replaceAll('</script', '<\\/script') +
      '</script></body></html>',
  );
  const output = await new Promise((resolve, reject) => {
    const child = (browser = spawn(
      chrome,
      [
        '--headless',
        '--disable-gpu',
        '--no-sandbox',
        '--no-first-run',
        '--disable-background-networking',
        '--disable-component-update',
        // Headless Chrome still boots its full browser services. On a CI runner those
        // reach for D-Bus/UPower/NetworkManager and retry GCM registration for tens of
        // seconds, which is enough to keep `--virtual-time-budget` from ever expiring —
        // so the DOM is never dumped and the run times out with a passing page. This is
        // the puppeteer launch set, minus what is already above.
        '--disable-sync',
        '--disable-extensions',
        '--disable-default-apps',
        '--disable-component-extensions-with-background-pages',
        '--disable-client-side-phishing-detection',
        '--no-default-browser-check',
        '--metrics-recording-only',
        '--disable-breakpad',
        '--mute-audio',
        // Small /dev/shm (containers, some runners) crashes the renderer mid-load.
        '--disable-dev-shm-usage',
        `--user-data-dir=${join(temp, 'profile')}`,
        '--virtual-time-budget=5000',
        '--dump-dom',
        pathToFileURL(html).href,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ));
    let htmlOutput = '';
    let stderrOutput = '';
    // A passing run takes ~1 s locally; the budget only has to cover a cold CI browser
    // start, so it is set well clear of that rather than tuned.
    const timeoutMs = 90000;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error(
          `Browser regression tests timed out after ${timeoutMs / 1000}s (no complete DOM dump). Chrome (${chrome}) stderr:\n${stderrOutput}`,
        ),
      );
    }, timeoutMs);
    const settle = (result) => {
      clearTimeout(timer);
      child.removeAllListeners('close');
      resolve(result);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      htmlOutput += chunk;
      // Chrome can linger after dumping DOM on macOS. The dump is the entire result, so
      // stop waiting on the process once it is complete — settle first, then ask this
      // isolated instance to exit. Waiting for 'close' here would let a lingering Chrome
      // turn a passing run into a timeout.
      if (htmlOutput.includes('</html>')) {
        settle({ html: htmlOutput, stderr: stderrOutput });
        child.kill();
        // Chrome ignoring SIGTERM must not keep the temp profile dir locked past cleanup.
        setTimeout(() => child.kill('SIGKILL'), 2000).unref();
      }
    });
    child.stderr.setEncoding('utf8');
    let stderrHead = '';
    let stderrTail = '';
    child.stderr.on('data', (chunk) => {
      // Chrome is chatty on stderr even on success (DevTools listening, GPU/crashpad
      // notices) and floods it on failure. Keep both ends: the launch/load error is in
      // the head, the reason it is still alive is in the tail. A pure tail buffer hides
      // the actual cause behind whatever noise Chrome emitted last.
      if (stderrHead.length < 2000) stderrHead += chunk;
      else stderrTail = (stderrTail + chunk).slice(-2000);
      stderrOutput = stderrTail === '' ? stderrHead : `${stderrHead}\n…\n${stderrTail}`;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(stderrOutput === '' ? error : new Error(`${error.message}\nChrome stderr:\n${stderrOutput}`));
    });
    child.on('close', () => {
      settle({ html: htmlOutput, stderr: stderrOutput });
    });
  });
  assert.ok(
    output.html.includes('data-result="pass"'),
    output.html.trim() === ''
      ? `Browser produced no DOM. Chrome (${chrome}) stderr:\n${output.stderr || '(empty)'}`
      : output.html,
  );
  console.log('Client regression checks passed');
} finally {
  // We settle on the DOM dump rather than on process exit, so Chrome is usually still
  // alive here with the temp profile dir open. Kill it and wait (bounded) for the exit
  // before removing the dir — otherwise rmSync races Chrome's own writes and throws
  // ENOTEMPTY on a run that actually passed.
  if (browser !== null && browser.exitCode === null && browser.signalCode === null) {
    browser.kill('SIGKILL');
    await new Promise((resolve) => {
      const giveUp = setTimeout(resolve, 5000);
      browser.once('exit', () => {
        clearTimeout(giveUp);
        resolve(undefined);
      });
    });
  }
  // Retry anyway: on macOS the dir can stay busy for a beat after the process is reaped.
  rmSync(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}
