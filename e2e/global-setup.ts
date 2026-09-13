import { spawn } from 'node:child_process';
import { freePort, waitFor } from './helpers/ports.js';
// @ts-expect-error -- plain .mjs helper, no declaration file by design
import { ensureLightpanda, lightpandaVersion } from './scripts/ensure-lightpanda.mjs';

/**
 * Start one Lightpanda CDP server for the whole run and hand its endpoint to the workers
 * through the environment (Playwright forks workers from this process, so assignments to
 * `process.env` here are inherited).
 *
 * Skipped entirely under E2E_BROWSER=chromium.
 */
export default async function globalSetup(): Promise<void> {
  if (process.env.E2E_BROWSER === 'chromium') {
    console.log('[e2e] E2E_BROWSER=chromium — skipping Lightpanda');
    return;
  }

  const bin: string = ensureLightpanda();
  console.log(`[e2e] lightpanda ${lightpandaVersion(bin)}`);

  const port = await freePort();
  // --load-resources stylesheet: external CSS is NOT fetched by default, and several
  // assertions depend on computed styles / checkVisibility seeing the real stylesheet.
  const child = spawn(
    bin,
    ['serve', '--host', '127.0.0.1', '--port', String(port), '--load-resources', 'stylesheet'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let log = '';
  child.stdout?.on('data', (c: Buffer) => (log += c.toString()));
  child.stderr?.on('data', (c: Buffer) => (log += c.toString()));

  let exited = false;
  child.on('exit', () => (exited = true));

  await waitFor(
    async () => {
      if (exited) throw new Error(`lightpanda exited before becoming ready:\n${log}`);
      try {
        return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok;
      } catch {
        return false;
      }
    },
    { timeoutMs: 20_000, what: 'the Lightpanda CDP endpoint' },
  );

  process.env.E2E_CDP_ENDPOINT = `ws://127.0.0.1:${port}`;
  process.env.E2E_LIGHTPANDA_PID = String(child.pid);
  child.unref();
}
