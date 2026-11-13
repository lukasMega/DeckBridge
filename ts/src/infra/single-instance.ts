// One DeckBridge per machine. A held loopback listener is the lock: the OS frees it on
// any exit (even a crash), so unlike a lock file it can never go stale.
import { INSTANCE_LOCK_PORT } from '../shared/types.js';

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

/** Test seam: drop the lock so a test can re-acquire it. */
export function releaseInstanceLock(): void {
  held?.close();
  held = null;
}
