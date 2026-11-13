// The real WslRunner (Windows): argv arrays straight to spawnOwned, never `cmd /c`
// (runCommand wraps a shell and its quoting mangles `sh -c '...'` arguments).
// Not covered by CI (no WSL on hosted runners); the controller is tested with fakes.
import { spawnOwned } from './owned-spawn.js';
import { decodeWslText, looksUtf16 } from './wsl-relay-parse.js';
import type { WslRunner, WslSpawned } from './wsl-relay.js';

const KILL_GRACE_MS = 2000;
const DOWNLOAD_TIMEOUT_MS = 300_000;
const SHORT_TIMEOUT_MS = 30_000;

/** System32 first: Git for Windows' GNU tar can't read zips, and its curl may differ. */
function system32(exe: string): string {
  const root = tjs.env.SystemRoot ?? 'C:\\Windows';
  return `${root}\\System32\\${exe}`;
}

function kill(p: TjsProcess, signal: string): void {
  try {
    p.kill(signal);
  } catch {
    // already gone
  }
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

async function run(
  argv: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string; timedOut: boolean }> {
  const p = spawnOwned(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    kill(p, 'SIGKILL');
  }, timeoutMs);
  try {
    const [bytes, { exit_status }] = await Promise.all([readBytes(p.stdout), p.wait()]);
    return { code: exit_status, stdout: decodeWslText(bytes), timedOut };
  } finally {
    clearTimeout(timer);
  }
}

async function runOk(argv: string[], timeoutMs: number): Promise<string> {
  const { code, stdout, timedOut } = await run(argv, timeoutMs);
  if (timedOut) throw new Error(`${argv[0]!.split('\\').pop()} timed out`);
  if (code !== 0) throw new Error(`${argv[0]!.split('\\').pop()} exited with ${code}`);
  return stdout;
}

/** Splits a byte stream into lines; wsl.exe's own UTF-16 text is decoded per chunk. */
async function pumpLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const utf8 = new TextDecoder();
  let buf = '';
  for await (const chunk of stream) {
    buf += looksUtf16(chunk) ? decodeWslText(chunk) : utf8.decode(chunk, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const l of lines) onLine(l.replace(/\r$/, ''));
  }
  if (buf !== '') onLine(buf);
}

function dirOf(path: string): string {
  return path.slice(0, Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')));
}

export function createWindowsWslRunner(): WslRunner {
  return {
    exec: (args, timeoutMs) => run(['wsl.exe', '-e', ...args], timeoutMs),

    spawn(args, onLine): WslSpawned {
      const p = spawnOwned(['wsl.exe', '-e', ...args], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const pumps = Promise.all([pumpLines(p.stdout, onLine), pumpLines(p.stderr, onLine)]).catch(
        () => undefined,
      );
      const exited = p.wait().then(async (r) => {
        await pumps; // the last lines (the crash reason) arrive before the exit
        return r.term_signal ? null : r.exit_status;
      });
      return {
        exited,
        async stop(): Promise<void> {
          kill(p, 'SIGTERM');
          const timer = setTimeout(() => kill(p, 'SIGKILL'), KILL_GRACE_MS);
          try {
            await exited;
          } finally {
            clearTimeout(timer);
          }
        },
      };
    },

    async download(url, dest): Promise<void> {
      await tjs.makeDir(dirOf(dest), { recursive: true });
      await runOk(
        [system32('curl.exe'), '-fsSL', '--retry', '2', '--max-time', '280', '-o', dest, url],
        DOWNLOAD_TIMEOUT_MS,
      );
    },

    fetchText: (url) =>
      runOk([system32('curl.exe'), '-fsSL', '--max-time', '25', url], SHORT_TIMEOUT_MS),

    async sha256(path): Promise<string> {
      const out = await runOk([system32('certutil.exe'), '-hashfile', path, 'SHA256'], 60_000);
      const hex = out
        .split('\n')
        .map((l) => l.replace(/\s/g, ''))
        .find((l) => /^[0-9a-f]{64}$/i.test(l));
      if (hex === undefined) throw new Error('certutil printed no SHA256');
      return hex.toLowerCase();
    },

    async unzip(zip, dir): Promise<void> {
      await tjs.makeDir(dir, { recursive: true });
      await runOk(
        [system32('tar.exe'), '-xf', zip, '-C', dir, '--strip-components=1'],
        SHORT_TIMEOUT_MS * 2,
      );
    },

    async toWslPath(winPath): Promise<string> {
      const out = await runOk(['wsl.exe', '-e', 'wslpath', '-a', winPath], SHORT_TIMEOUT_MS);
      return out.trim();
    },

    async exists(path): Promise<boolean> {
      try {
        return (await tjs.stat(path)).isFile;
      } catch {
        return false;
      }
    },

    async promote(stage, dir): Promise<void> {
      await tjs.remove(dir, { recursive: true }).catch(() => undefined);
      await tjs.rename(stage, dir);
    },

    async pruneOthers(root, keep): Promise<void> {
      try {
        for await (const e of await tjs.readDir(root)) {
          if (!e.isDirectory || e.name === keep) continue;
          await tjs.remove(`${root}${root.includes('\\') ? '\\' : '/'}${e.name}`, {
            recursive: true,
          });
        }
      } catch {
        // best effort
      }
    },
  };
}
