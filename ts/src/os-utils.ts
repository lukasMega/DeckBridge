// Best-effort "open this path with the OS's default handler" — shared by
// app.ts's browser-launch and the WebUI's "open settings.json" action.

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
  } catch {
    // best-effort — silently ignored on headless Linux or missing opener
  }
}
