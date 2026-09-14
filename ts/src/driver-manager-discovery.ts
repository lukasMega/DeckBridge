import type { DeviceModel } from './devices/driver.js';
import { cachedDiscoveryPaths } from './ffi/hid-discovery.js';
import type { ElgatoServer, ElgatoChildServer } from './elgato.js';
import type { SessionServersFactory } from './device-session.js';
import type { WebUIServer } from './web/server/index.js';

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

export function defaultPresenceCheck(model: DeviceModel): boolean {
  return cachedDiscoveryPaths(model.usbVendorId, model.usbProductIds).length > 0;
}

export function defaultListModelPaths(model: DeviceModel): string[] {
  const { usagePage, usage } = model;
  return cachedDiscoveryPaths(model.usbVendorId, model.usbProductIds, usagePage, usage);
}
