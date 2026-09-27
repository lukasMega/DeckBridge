// DriverManager's construction inputs and start mode, kept apart from the
// discovery helpers so driver-manager.ts stays under the 500-line gate.
import type { ElgatoServer } from '../cora/primary-server.js';
import type { ElgatoChildServer } from '../cora/child-server.js';
import type { SessionServersFactory } from './device-session.js';
import type { WebUIServer } from '../web/server/index.js';
import type { PersistedSettings } from '../infra/settings.js';
import type { HidDiscovery } from './driver-manager-discovery.js';
import type { WorkerPool } from './worker-pool.js';

export type DriverMode = 'real' | 'mock';

export interface DriverManagerDeps {
  webui: WebUIServer;
  settings: PersistedSettings;
  server: ElgatoServer;
  childServer: ElgatoChildServer;
  onTrayChange: () => void;
  getShuttingDown: () => boolean;
  sessionServersFactory?: SessionServersFactory;
  onDocksChanged?: () => void;
  /** Injected by tests (no hardware/FFI); default nativeHidDiscovery() / new WorkerPool(). */
  discovery?: HidDiscovery;
  pool?: WorkerPool;
}

export function getInitialDriverMode(): DriverMode {
  return tjs.env['DECKBRIDGE_MOCK'] === '1' ? 'mock' : 'real';
}
