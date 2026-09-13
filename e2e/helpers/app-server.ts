import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { freePort, isPortFree, waitFor } from './ports.js';

const REPO = resolve(import.meta.dirname, '..', '..');

// Hardcoded in ts/src/types.ts and not configurable — see the plan, §3.
const CORA_PORTS = [5343, 5344];

export interface AppServer {
  baseURL: string;
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

/**
 * `app.ts` awaits `startCoraWithRetry()` before `connectMock()`, and that retry loop
 * never gives up. With 5343/5344 occupied the mock driver therefore never connects, the
 * UI sits on "Let's get you set up" forever, and every stage assertion fails with an
 * unhelpful timeout. Fail here instead, naming the ports.
 */
async function assertCoraPortsFree(): Promise<void> {
  const busy: number[] = [];
  for (const p of CORA_PORTS) if (!(await isPortFree(p))) busy.push(p);
  if (busy.length > 0) {
    throw new Error(
      `CORA port(s) ${busy.join(', ')} are in use — another DeckBridge (or the Elgato dock) is running.\n` +
        'The app e2e suite needs them free: app.ts awaits the CORA listeners before connecting the\n' +
        'mock driver, so an occupied port leaves the UI permanently in the "no device" stage.',
    );
  }
}

/** Boot the real bundle in mock mode on a private port + cache dir, and wait for readiness. */
export async function startAppServer(): Promise<AppServer> {
  await assertCoraPortsFree();

  const bundle = join(REPO, 'ts', 'dist', 'bundle.js');
  if (!existsSync(bundle)) throw new Error(`${bundle} missing — run \`mise run build\` first`);

  const port = await freePort();
  const cacheDir = mkdtempSync(join(tmpdir(), 'deckbridge-e2e-'));
  const baseURL = `http://127.0.0.1:${port}`;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DECKBRIDGE_MOCK: '1',
    DECKBRIDGE_NATIVE_LIB: nativeLibPath(),
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

  return { baseURL, stop };
}
