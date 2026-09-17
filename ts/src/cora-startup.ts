import type { LogLevel } from './logger.js';

/** Minimal server shape needed to start/stop the CORA primary/child servers. */
export interface CoraStartable {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface CoraStartupDeps {
  server: CoraStartable;
  childServer: CoraStartable;
  log: (level: LogLevel, component: string, message: string) => void;
  webuiLog: (level: LogLevel, component: string, message: string) => void;
  getShuttingDown: () => boolean;
  /** CORA primary TCP port (5343), included in the conflict message. */
  elgatoTcpPort: number;
  /** CORA child TCP port (5344), included in the conflict message. */
  elgatoChildPort: number;
}

/** The one CORA bind-conflict wording — the primary's retry loop and every extra
 *  dock emit it identically, and users paste it into issue reports verbatim. */
export function coraPortConflict(primary: number, child: number, detail: string): string {
  return `CORA port ${primary}/${child} in use — is another DeckBridge / Elgato dock running? (${detail})`;
}

/**
 * Start the CORA primary + child servers, retrying on bind failure (another instance, a
 * real Elgato dock, or the ESP32 bridge holding 5343/5344). The ports are protocol-fixed
 * and cannot fall back, hence retry rather than rebind. `getShuttingDown()` is re-checked
 * each iteration so a signal during the wait bails instead of retrying forever.
 */
export async function startCoraWithRetry(deps: CoraStartupDeps, delayMs = 5000): Promise<void> {
  const { server, childServer, log, webuiLog, getShuttingDown, elgatoTcpPort, elgatoChildPort } =
    deps;
  for (let attempt = 1; ; attempt++) {
    if (getShuttingDown()) return;
    try {
      await server.start();
      await childServer.start();
      return;
    } catch (err) {
      const msg = coraPortConflict(elgatoTcpPort, elgatoChildPort, `attempt ${attempt}`);
      log('error', 'elgato', `${msg}: ${(err as Error).message}`);
      webuiLog('error', 'elgato', msg);
      await server.stop().catch(() => undefined);
      await childServer.stop().catch(() => undefined);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
