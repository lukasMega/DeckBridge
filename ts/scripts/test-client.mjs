// Real Preact/DOM regression checks. Requires Chrome or CHROME_BIN.
//
// The page is driven over the DevTools protocol rather than with `--dump-dom`: on a
// Linux CI runner that flag never produces output (Chrome 153 hangs on it even for
// about:blank, while the same version dumps fine on macOS), which turned a passing
// suite into a timeout. CDP also lets us surface page exceptions and console errors
// when a check fails, instead of guessing from a DOM dump.
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const LAUNCH_TIMEOUT_MS = 30000;
const RESULT_TIMEOUT_MS = 60000;

const temp = mkdtempSync(join(tmpdir(), 'deckbridge-client-test-'));
const chrome =
  process.env.CHROME_BIN ??
  (process.platform === 'darwin' &&
  existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : 'google-chrome');

/** Minimal CDP client: id/response matching plus a buffer of the events we care about. */
function cdpClient(socket) {
  let nextId = 1;
  const pending = new Map();
  const pageErrors = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      const slot = pending.get(message.id);
      pending.delete(message.id);
      if (!slot) return;
      if (message.error) slot.reject(new Error(message.error.message));
      else slot.resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown')
      pageErrors.push(message.params.exceptionDetails.exception?.description ?? 'exception');
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error')
      pageErrors.push(message.params.args.map((a) => a.description ?? a.value).join(' '));
  });
  return {
    pageErrors,
    send(method, params, sessionId) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      });
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  let stderrHead = '';
  let stderrTail = '';
  const stderrSnapshot = () => (stderrTail === '' ? stderrHead : `${stderrHead}\n…\n${stderrTail}`);

  // Wait for the DevTools endpoint Chrome prints on stderr once the browser is up.
  const wsEndpoint = await new Promise((resolve, reject) => {
    browser = spawn(
      chrome,
      [
        '--headless',
        '--disable-gpu',
        '--no-sandbox',
        '--no-first-run',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--disable-extensions',
        '--disable-default-apps',
        '--disable-client-side-phishing-detection',
        '--no-default-browser-check',
        '--metrics-recording-only',
        '--disable-breakpad',
        '--mute-audio',
        // Small /dev/shm (containers, some runners) crashes the renderer mid-load.
        '--disable-dev-shm-usage',
        `--user-data-dir=${join(temp, 'profile')}`,
        '--remote-debugging-port=0',
        'about:blank',
      ],
      // Own process group: killing the browser process alone orphans its zygote and
      // renderers, which keep writing the profile dir and defeat the cleanup below.
      { stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' },
    );
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Chrome (${chrome}) never announced a DevTools endpoint within ${LAUNCH_TIMEOUT_MS / 1000}s. stderr:\n${stderrSnapshot()}`,
        ),
      );
    }, LAUNCH_TIMEOUT_MS);
    browser.stderr.setEncoding('utf8');
    browser.stderr.on('data', (chunk) => {
      // Chrome is chatty on stderr even on success and floods it on failure. Keep both
      // ends: the launch error is in the head, the reason it is still alive in the tail.
      if (stderrHead.length < 2000) stderrHead += chunk;
      else stderrTail = (stderrTail + chunk).slice(-2000);
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderrHead);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    browser.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    browser.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome (${chrome}) exited with code ${code}. stderr:\n${stderrSnapshot()}`));
    });
  });

  const socket = new WebSocket(wsEndpoint);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error(`Cannot reach ${wsEndpoint}`)), {
      once: true,
    });
  });
  const cdp = cdpClient(socket);
  const { targetId } = await cdp.send('Target.createTarget', { url: pathToFileURL(html).href });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);

  // The suite is async: poll for the result marker the page sets when it settles.
  const deadline = Date.now() + RESULT_TIMEOUT_MS;
  let page = { result: '', text: '' };
  while (Date.now() < deadline) {
    const evaluated = await cdp.send(
      'Runtime.evaluate',
      {
        expression:
          "({ result: document.body.dataset.result ?? '', text: document.body.textContent })",
        returnByValue: true,
      },
      sessionId,
    );
    page = evaluated.result.value;
    if (page.result !== '') break;
    await sleep(50);
  }
  socket.close();

  const diagnostics = [page.text, ...cdp.pageErrors].filter(Boolean).join('\n');
  assert.ok(
    page.result === 'pass',
    page.result === ''
      ? `Page never reported a result within ${RESULT_TIMEOUT_MS / 1000}s.\n${diagnostics}`
      : diagnostics,
  );
  console.log('Client regression checks passed');
} finally {
  // Chrome is still running here — we never wait on its exit. Kill it and wait (bounded)
  // for the process to go before removing the dir it has open, or rmSync races Chrome's
  // own profile writes and throws ENOTEMPTY on a run that actually passed.
  if (browser !== null && browser.exitCode === null && browser.signalCode === null) {
    try {
      if (process.platform === 'win32') browser.kill('SIGKILL');
      else process.kill(-browser.pid, 'SIGKILL'); // whole group: browser + zygote + renderers
    } catch {
      browser.kill('SIGKILL');
    }
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
