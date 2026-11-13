import { connect, createServer } from 'node:net';

/** Ask the OS for an unused TCP port on 127.0.0.1. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        srv.close();
        reject(new Error('could not determine a free port'));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

/** Ask for `n` unused consecutive TCP ports; returns the first (the browser deck is dock 3,
 *  so a CORA block of 8 puts its pair at base+6 / base+7). */
export async function freePortBlock(n: number): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const base = await freePort();
    if (base + n >= 65_535) continue;
    let free = true;
    for (let i = 1; i < n && free; i++) free = await isPortFree(base + i);
    if (free) return base;
  }
  throw new Error(`could not find ${n} free consecutive ports`);
}

/**
 * True when nothing is listening on 127.0.0.1:<port>.
 *
 * Probes by *connecting*, not by binding. A bind probe is wrong here: Node sets
 * SO_REUSEADDR, which on BSD/macOS lets 127.0.0.1:5343 bind successfully while another
 * process already holds 0.0.0.0:5343 — exactly how DeckBridge binds its CORA listeners.
 * The bind would report "free" and the app would then die on EADDRINUSE anyway.
 */
export function isPortFree(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ port, host: '127.0.0.1' });
    const done = (free: boolean) => {
      sock.destroy();
      resolve(free);
    };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => done(false));
    sock.on('error', () => done(true));
    sock.on('timeout', () => done(true));
  });
}

/** Poll `probe` until it resolves true, or throw after `timeoutMs`. */
export async function waitFor(
  probe: () => Promise<boolean>,
  { timeoutMs, intervalMs = 150, what }: { timeoutMs: number; intervalMs?: number; what: string },
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return;
    if (Date.now() > deadline)
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
