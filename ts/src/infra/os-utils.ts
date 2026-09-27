// Best-effort "open this path with the OS's default handler" — shared by app.ts's
// browser-launch and the WebUI's "open settings.json" action — plus the
// Elgato-desktop-app process probe (used by app.ts's conflict poll and diagnostics), and
// the shell runner behind the command widget and encoder commands.

const [MAC_OS, WIN] = ['macOS', 'Windows'];

/** Drain a child process's stdout to a string. The trailing `decode()` flushes a UTF-8
 *  sequence split across the final chunk boundary; without it those bytes are dropped. */
export async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}

/** Read a spawned process' stdout to a string, killing it after `timeoutMs` so
 *  a hung command can't wedge the entry on inflight forever. */
export async function runCommand(cmd: string, timeoutMs: number): Promise<string> {
  const args = platformName() === 'Windows' ? ['cmd', '/c', cmd] : ['sh', '-c', cmd];
  const p = tjs.spawn(args, { stdout: 'pipe', stderr: 'ignore' });
  const killer = setTimeout(() => p.kill(), timeoutMs);
  try {
    const out = await readText(p.stdout);
    await p.wait();
    return out;
  } finally {
    clearTimeout(killer);
  }
}

/** Best-effort `navigator.userAgentData.platform` read. A txiki build lacking
 *  `userAgentData` must not throw — the empty string falls through to the dns-sd
 *  default branch in `buildArgs`. */
export function platformName(): string {
  try {
    return navigator.userAgentData?.platform ?? '';
  } catch {
    return '';
  }
}

/** Is the Elgato Stream Deck desktop app running? macOS/Windows only — there is no
 *  Linux build, so every other platform answers `false`. Process presence only — see
 *  `elgatoAppConflict` (status-publisher.ts) for the actual device-contention signal. */
export async function isElgatoAppRunning(): Promise<boolean> {
  const platform = platformName();
  if (platform !== MAC_OS && platform !== WIN) return false;
  try {
    if (platform === MAC_OS) {
      const p = tjs.spawn(['pgrep', '-x', 'Stream Deck'], { stdout: 'ignore', stderr: 'ignore' });
      const { exit_status } = await p.wait();
      return exit_status === 0;
    }
    const p = tjs.spawn(['tasklist', '/FI', 'IMAGENAME eq StreamDeck.exe', '/NH'], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const out = await readText(p.stdout);
    await p.wait();
    return out.toLowerCase().includes('streamdeck.exe');
  } catch {
    return false;
  }
}

/** Opens `path` (a file path or URL) with the platform's default handler.
 *  Silently ignored on failure (headless Linux, missing opener, sandboxed
 *  environment, etc.) — this is a convenience action, never load-bearing. */
export async function openPathInOS(path: string): Promise<void> {
  try {
    const platform = platformName();
    let cmd: string[];
    if (platform === MAC_OS) cmd = ['open', path];
    else if (platform === WIN) cmd = ['cmd', '/c', 'start', '', path];
    else cmd = ['xdg-open', path]; // Linux: no-op on headless (exits non-zero, caught below)
    await tjs.spawn(cmd, { stdout: 'ignore', stderr: 'ignore' }).wait();
  } catch {}
}
