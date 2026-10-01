// The one thing app.ts calls: builds the VirtualDock and subscribes it to the WebUI events.
import type { PersistedSettings } from '../../infra/settings.js';
import type { WebUIServer } from '../../web/server/index.js';
import type { CoraDockFactory } from '../dock-scanner-deps.js';
import { VirtualDock, type VirtualDockHost } from './virtual-dock.js';

export interface VirtualDeckWiringDeps {
  webui: WebUIServer;
  settings: PersistedSettings;
  driverManager: VirtualDockHost;
  coraDockFactory: CoraDockFactory;
  getShuttingDown: () => boolean;
  onDockConnected: (dockIndex: number, deviceKey: string) => void;
}

export function wireVirtualDeck(deps: VirtualDeckWiringDeps): {
  start(): Promise<void>;
  stop(): Promise<void>;
} {
  const dock = new VirtualDock({
    controller: deps.webui.virtualDeck,
    settings: deps.settings,
    host: deps.driverManager,
    coraDockFactory: deps.coraDockFactory,
    getShuttingDown: deps.getShuttingDown,
    onDockConnected: deps.onDockConnected,
  });
  deps.webui.on('virtualDeckChanged', () => void dock.sync());
  deps.webui.on('tokenRevoked', (id: string) => dock.kick(id));
  return { start: () => dock.sync(), stop: () => dock.shutdown() };
}
