import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { freePort, waitFor } from './ports.js';

const REPO = resolve(import.meta.dirname, '..', '..');
const SITE = join(REPO, 'docs-site');

/** `baseUrl` from docs-site/docusaurus.config.ts — the site lives on a subpath. */
export const DOCS_BASE_PATH = '/DeckBridge';

export interface DocsServer {
  /** e.g. http://127.0.0.1:41234/DeckBridge — routes append directly (`/introduction`). */
  baseURL: string;
  stop(): Promise<void>;
}

/**
 * Serve the *production* build. Two reasons this is `docusaurus serve` and not
 * `docusaurus start`:
 *   - the local search index only exists in a production build; the dev server renders
 *     "⚠️ The search index is only available when you run docusaurus build!";
 *   - the dev server re-compiles, which would make a test run minutes long.
 *
 * `--host 127.0.0.1` is not optional: the default (`localhost`) binds IPv6-only here, and
 * every 127.0.0.1 request then fails to connect.
 */
export async function startDocsServer(): Promise<DocsServer> {
  const build = join(SITE, 'build');
  if (!existsSync(join(build, 'index.html'))) {
    throw new Error(`${build}/index.html missing — run \`mise run docs-build\` first`);
  }

  const port = await freePort();
  const baseURL = `http://127.0.0.1:${port}${DOCS_BASE_PATH}`;

  const child: ChildProcess = spawn(
    'pnpm',
    [
      'exec',
      'docusaurus',
      'serve',
      '--dir',
      'build',
      '--port',
      String(port),
      '--host',
      '127.0.0.1',
      '--no-open',
    ],
    { cwd: SITE, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let log = '';
  const capture = (chunk: Buffer) => {
    log += chunk.toString();
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);

  let exited = false;
  child.on('exit', () => {
    exited = true;
  });

  const stop = async (): Promise<void> => {
    if (exited) return;
    child.kill('SIGTERM');
    await waitFor(async () => exited, { timeoutMs: 5000, what: 'docusaurus serve shutdown' }).catch(
      () => {
        child.kill('SIGKILL');
      },
    );
  };

  try {
    await waitFor(
      async () => {
        // A busy port makes `docusaurus serve` exit silently in non-TTY mode.
        if (exited) throw new Error(`docusaurus serve exited before becoming ready:\n${log}`);
        try {
          return (await fetch(`${baseURL}/`)).ok;
        } catch {
          return false;
        }
      },
      { timeoutMs: 30_000, what: `GET ${baseURL}/ to answer` },
    );
  } catch (err) {
    await stop();
    throw new Error(`${(err as Error).message}\n--- docusaurus output ---\n${log}`);
  }

  return { baseURL, stop };
}
