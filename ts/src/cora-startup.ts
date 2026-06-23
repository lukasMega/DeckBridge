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

/**
 * Start the CORA primary + child servers, retrying on bind failure (e.g. another
 * mira2el instance, a real Elgato dock, or the ESP32 bridge already holding
 * 5343/5344). CORA ports are protocol-fixed and cannot fall back, so on failure
 * both servers are stopped (for a clean retry) and a clear conflict message is
 * logged to both the console log and the WebUI log feed before waiting and
 * retrying.
 *
 * Checks `getShuttingDown()` at the top of each retry iteration so a shutdown
 * signal received during the wait causes a clean bail (return) instead of an
 * infinite retry after the process is asked to exit.
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
      const msg =
        `CORA port ${elgatoTcpPort}/${elgatoChildPort} in use ` +
        `— is another DeckBridge / Elgato dock running? (attempt ${attempt})`;
      log('error', 'elgato', `${msg}: ${(err as Error).message}`);
      webuiLog('error', 'elgato', msg);
      await server.stop().catch(() => undefined);
      await childServer.stop().catch(() => undefined);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
