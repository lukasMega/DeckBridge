// Best-effort "open this path with the OS's default handler" — shared by
// app.ts's browser-launch and the WebUI's "open settings.json" action — plus
// the Elgato-desktop-app process probe (app.ts's conflict poll and the
// diagnostics report both need it).

const [MAC_OS, WIN] = ['macOS', 'Windows'];

/**
 * Best-effort `navigator.userAgentData.platform` read. A txiki build lacking
 * `userAgentData` must not throw — fall through to the dns-sd default branch
 * in `buildArgs` via an empty string.
 */
export function platformName(): string {
  try {
    return navigator.userAgentData?.platform ?? '';
  } catch {
    return '';
  }
}

/** Is the Elgato Stream Deck desktop app running? macOS/Windows only — there is
 *  no Linux build of it, so every other platform answers `false`.
 *
 *  This is process presence only. It says nothing about who owns the USB device:
 *  the app can be running happily while DeckBridge holds the hardware and the app
 *  talks to it over CORA. See `elgatoAppConflict` (status-publisher.ts) for the
 *  "app has the device, we can't open it" signal. */
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
    const dec = new TextDecoder();
    let out = '';
    const reader = p.stdout.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
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
