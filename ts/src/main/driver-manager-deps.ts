// DriverManager's construction inputs and start mode, kept apart from the
// discovery helpers so driver-manager.ts stays under the 500-line gate.
import type { ElgatoServer } from '../cora/primary-server.js';
import type { ElgatoChildServer } from '../cora/child-server.js';
import type { SessionServersFactory } from './device-session.js';
import type { WebUIServer } from '../web/server/index.js';

export type DriverMode = 'real' | 'mock';

export interface DriverManagerDeps {
  webui: WebUIServer;
  server: ElgatoServer;
  childServer: ElgatoChildServer;
  onTrayChange: () => void;
  getShuttingDown: () => boolean;
  sessionServersFactory?: SessionServersFactory;
  onDocksChanged?: () => void;
}

export function getInitialDriverMode(): DriverMode {
  return tjs.env['DECKBRIDGE_MOCK'] === '1' ? 'mock' : 'real';
}
