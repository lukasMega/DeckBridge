import { spawnOwned } from './owned-spawn.js';

export interface CurlResult {
  sent: boolean;
  reason?: 'offline' | 'no-curl' | 'rejected';
}

/** stdin keeps optional feedback out of process listings. */
export async function sendCurl(
  url: string,
  version: string,
  body?: string,
  timeoutMs = 15_000,
): Promise<CurlResult> {
  let p: TjsProcess;
  try {
    p = spawnOwned(
      [
        'curl',
        '-fsS',
        '--max-time',
        '10',
        '-o',
        '/dev/null',
        '-H',
        `User-Agent: DeckBridge/${version}`,
        ...(body === undefined
          ? []
          : ['-H', 'Content-Type: application/json', '--data-binary', '@-']),
        url,
      ],
      { stdin: body === undefined ? 'ignore' : 'pipe', stdout: 'ignore', stderr: 'ignore' },
    );
  } catch {
    return { sent: false, reason: 'no-curl' };
  }
  const killer = setTimeout(() => {
    try {
      p.kill();
    } catch {}
  }, timeoutMs);
  try {
    if (body !== undefined) {
      const writer = p.stdin.getWriter();
      try {
        await writer.write(new TextEncoder().encode(body));
        await writer.close();
      } finally {
        writer.releaseLock();
      }
    }
    const { exit_status } = await p.wait();
    if (exit_status === 0) return { sent: true };
    return { sent: false, reason: exit_status === 22 ? 'rejected' : 'offline' };
  } catch {
    try {
      p.kill();
    } catch {}
    return { sent: false, reason: 'offline' };
  } finally {
    clearTimeout(killer);
  }
}
