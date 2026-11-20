// Read-only facts the pairing wizard (issue #257) needs: WSL distros on Windows, macOS
// version and installed VM runtimes on macOS. Spawns only, never boots a VM, never throws.
import type { PairingProbe } from '../web/contract-pairing-route.js';
import { spawnOwned } from './owned-spawn.js';
import { parseMacVersion, parseNecpBlocked, parseWslList } from './pairing-probe-parse.js';
import { decodeWslText } from './wsl-relay-parse.js';

const SPAWN_TIMEOUT_MS = 5000;

export interface ProbeRunner {
  /** `null` means the spawn failed (binary missing) or timed out. */
  run(argv: string[], timeoutMs: number): Promise<{ code: number; stdout: Uint8Array } | null>;
  exists(path: string): Promise<boolean>;
}

export interface ProbeDeps {
  runner: ProbeRunner;
  platform: string;
  lanIp: string;
  coraPort: number;
  webuiPort: number;
  relayScriptPort: number;
  webuiBind: string;
  /** For `~/.orbstack/bin/orb`; defaults to $HOME. */
  home?: string;
}

async function probeWsl(runner: ProbeRunner): Promise<NonNullable<PairingProbe['wsl']>> {
  const r = await runner.run(['wsl.exe', '-l', '-v'], SPAWN_TIMEOUT_MS);
  if (r === null || r.code !== 0) return { installed: false, distros: [] };
  return parseWslList(decodeWslText(r.stdout));
}

async function runText(runner: ProbeRunner, argv: string[]): Promise<string> {
  const r = await runner.run(argv, SPAWN_TIMEOUT_MS);
  return r !== null && r.code === 0 ? new TextDecoder().decode(r.stdout).trim() : '';
}

// Readable without sudo; the 5 minute window is ~1-2 s, a longer one takes minutes.
const NECP_LOG = [
  '/usr/bin/log',
  'show',
  '--last',
  '5m',
  '--style',
  'compact',
  '--predicate',
  'process == "kernel" AND eventMessage CONTAINS "reason: NECP" AND eventMessage CONTAINS "process: Stream Deck"',
];

/** macOS only. Async spawn with a timeout, so it never stalls the main thread. */
export async function streamDeckNecpBlocked(runner: ProbeRunner): Promise<boolean> {
  const r = await runner.run(NECP_LOG, 8000);
  return r !== null && r.code === 0 && parseNecpBlocked(new TextDecoder().decode(r.stdout));
}

async function probeMac(
  runner: ProbeRunner,
  home: string,
): Promise<NonNullable<PairingProbe['mac']>> {
  const [version, uname, appOrb, cliOrb, container] = await Promise.all([
    runText(runner, ['sw_vers', '-productVersion']),
    runText(runner, ['uname', '-m']),
    runner.exists('/Applications/OrbStack.app'),
    home === '' ? false : runner.exists(`${home}/.orbstack/bin/orb`),
    runner.exists('/usr/local/bin/container'),
  ]);
  const orbstack = appOrb || cliOrb;
  return {
    version: parseMacVersion(version),
    arch: uname === 'x86_64' ? 'x86_64' : 'arm64',
    orbstack,
    container,
    localNetworkBlocked: orbstack && (await streamDeckNecpBlocked(runner)),
  };
}

export async function probePairing(deps: ProbeDeps): Promise<PairingProbe> {
  const { runner, platform } = deps;
  let wsl: PairingProbe['wsl'] = null;
  let mac: PairingProbe['mac'] = null;
  try {
    if (platform === 'Windows') wsl = await probeWsl(runner);
    else if (platform === 'macOS') mac = await probeMac(runner, deps.home ?? tjs.env.HOME ?? '');
  } catch {
    if (platform === 'Windows') wsl = { installed: false, distros: [] };
    else if (platform === 'macOS')
      mac = {
        version: '',
        arch: 'arm64',
        orbstack: false,
        container: false,
        localNetworkBlocked: false,
      };
  }
  return {
    platform: platform === 'Windows' || platform === 'macOS' ? platform : 'other',
    lanIp: deps.lanIp,
    coraPort: deps.coraPort,
    webuiPort: deps.webuiPort,
    relayScriptPort: deps.relayScriptPort,
    lanReachable: !deps.webuiBind.startsWith('127.'),
    wsl,
    mac,
  };
}

async function readBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    parts.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

function kill(p: TjsProcess): void {
  try {
    p.kill('SIGKILL');
  } catch {
    // already gone
  }
}

export function createProbeRunner(): ProbeRunner {
  return {
    async run(argv, timeoutMs) {
      let p: TjsProcess;
      try {
        p = spawnOwned(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
      } catch {
        return null;
      }
      const state = { timedOut: false };
      const timer = setTimeout(() => {
        state.timedOut = true;
        kill(p);
      }, timeoutMs);
      try {
        const [stdout, { exit_status }] = await Promise.all([readBytes(p.stdout), p.wait()]);
        return state.timedOut ? null : { code: exit_status, stdout };
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
    async exists(path) {
      try {
        await tjs.stat(path);
        return true;
      } catch {
        return false;
      }
    },
  };
}
