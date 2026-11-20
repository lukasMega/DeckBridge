// One DeckBridge per machine. A held loopback listener is the lock: the OS frees it on
// any exit (even a crash), so unlike a lock file it can never go stale.
import { INSTANCE_LOCK_PORT, WEBUI_PORT } from '../shared/types.js';

/** Server handle kept alive for the whole process; closing it would drop the lock. */
let held: TjsTCPServerSocket | null = null;

/** True when this process now owns the instance lock, false when another holds it.
 *  Idempotent: a second call from the owner stays true. */
export async function acquireInstanceLock(port: number = INSTANCE_LOCK_PORT): Promise<boolean> {
  if (held) return true;
  try {
    const server = await tjs.listen('tcp', '127.0.0.1', port);
    await server.opened;
    held = server;
    return true;
  } catch {
    return false;
  }
}

/** Multi-line refusal text: names the lock port and the per-OS way to find and kill the holder.
 *  The tray icon can be absent (headless, dev run, crashed tray), so it cannot be the only exit. */
export function alreadyRunningMessage(
  platform: string,
  port: number = INSTANCE_LOCK_PORT,
  webuiPort: number = WEBUI_PORT,
): string {
  const win = /win/i.test(platform) && !/darwin/i.test(platform);
  const kill = win
    ? [
        `  netstat -ano | findstr :${port}      (last column = PID)`,
        '  taskkill /PID <pid> /F',
        '  or: taskkill /IM deckbridge.exe /F',
      ]
    : [
        `  lsof -nP -iTCP:${port} -sTCP:LISTEN   (PID column)`,
        '  kill <pid>        (kill -9 <pid> if it ignores that)',
        '  or: pkill -x deckbridge',
      ];
  return [
    'DeckBridge is already running. Only one instance is allowed; exiting.',
    '',
    `The running instance holds 127.0.0.1:${port} as its instance lock.`,
    `It may still be there with no tray icon: headless run, dev run (process is tjs), or a crashed tray.`,
    `Open it: http://127.0.0.1:${webuiPort}   (or the port set by --webui-port)`,
    '',
    'To stop it:',
    ...kill,
    '',
    'The lock frees on any exit, so start again after the process is gone.',
  ].join('\n');
}

/** Test seam: drop the lock so a test can re-acquire it. */
export function releaseInstanceLock(): void {
  held?.close();
  held = null;
}
