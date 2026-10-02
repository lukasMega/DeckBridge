import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { freePort, freePortBlock, waitFor } from './ports.js';

const REPO = resolve(import.meta.dirname, '..', '..');

/** The browser deck is dock 3: CORA ports base + 2*3 (primary) and base + 2*3 + 1 (child). */
const VIRTUAL_DOCK_OFFSET = 6;

export interface AppServer {
  baseURL: string;
  childPort: number;
  /** The browser deck's listener (off until enabled via POST /api/virtual-deck). */
  deckURL: string;
  /** CORA child port of the browser deck's dock. */
  virtualChildPort: number;
  stop(): Promise<void>;
}

function tjsPath(): string {
  const fromEnv = process.env.TJS;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const vendored = join(
    REPO,
    'vendor',
    'txiki.js',
    'build',
    process.platform === 'win32' ? 'tjs.exe' : 'tjs',
  );
  if (existsSync(vendored)) return vendored;
  throw new Error('no txiki.js runtime found — run `mise run tjs-setup` (or set $TJS)');
}

function nativeLibPath(): string {
  const fromEnv = process.env.DECKBRIDGE_NATIVE_LIB;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const name =
    process.platform === 'win32'
      ? 'deckbridge_native.dll'
      : process.platform === 'darwin'
        ? 'libdeckbridge_native.dylib'
        : 'libdeckbridge_native.so';
  const built = join(REPO, 'rust', 'target', 'release', name);
  if (existsSync(built)) return built;
  throw new Error(
    'no deckbridge native lib found — run `mise run build` (or set $DECKBRIDGE_NATIVE_LIB)',
  );
}

/** Boot the real bundle in mock mode on a private port + cache dir, and wait for readiness. */
export async function startAppServer(): Promise<AppServer> {
  const bundle = join(REPO, 'ts', 'dist', 'mock', 'bundle.js');
  if (!existsSync(bundle)) throw new Error(`${bundle} missing — run \`mise run build\` first`);

  const port = await freePort();
  const coraPort = await freePortBlock(8);
  const childPort = coraPort + 1;
  const deckPort = await freePort();
  const cacheDir = mkdtempSync(join(tmpdir(), 'deckbridge-e2e-'));
  const baseURL = `http://127.0.0.1:${port}`;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DECKBRIDGE_MOCK: '1',
    DECKBRIDGE_CORA_PORT: String(coraPort),
    DECKBRIDGE_DECK_PORT: String(deckPort),
    DECKBRIDGE_NATIVE_LIB: nativeLibPath(),
    // Standby minutes become seconds and the app-gone debounce 1 s (mock builds only).
    DECKBRIDGE_STANDBY_FAST: '1',
  };
  // The tray sidecar is resolved from $DECKBRIDGE_TRAY_BIN *or* a sibling file; --headless
  // skips it entirely, but drop the env var too so a stale path can't be picked up.
  delete env.DECKBRIDGE_TRAY_BIN;
  delete env.DECKBRIDGE_OPEN;

  const child: ChildProcess = spawn(
    tjsPath(),
    ['run', bundle, '--headless', '--webui-port', String(port), '--cache-dir', cacheDir],
    { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] },
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
    if (!exited && child.pid !== undefined) {
      child.kill('SIGTERM');
      await waitFor(async () => exited, { timeoutMs: 5000, what: 'app shutdown' }).catch(() => {
        child.kill('SIGKILL');
      });
    }
    rmSync(cacheDir, { recursive: true, force: true });
  };

  try {
    // Same readiness gate the client itself blocks on before mounting (ui-entry.ts).
    await waitFor(
      async () => {
        if (exited) throw new Error(`app exited before becoming ready:\n${log}`);
        try {
          const res = await fetch(`${baseURL}/api/state`);
          if (!res.ok) return false;
          const state = (await res.json()) as { driverConnected?: boolean };
          return state.driverConnected === true;
        } catch {
          return false;
        }
      },
      { timeoutMs: 30_000, what: 'GET /api/state to report a connected mock driver' },
    );
  } catch (err) {
    await stop();
    throw new Error(`${(err as Error).message}\n--- app output ---\n${log}`);
  }

  // Click-to-press is opt-in (off by default); the specs that press keys need it on.
  await fetch(`${baseURL}/api/webui-key-press`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });

  return {
    baseURL,
    childPort,
    deckURL: `http://127.0.0.1:${deckPort}`,
    virtualChildPort: coraPort + VIRTUAL_DOCK_OFFSET + 1,
    stop,
  };
}
