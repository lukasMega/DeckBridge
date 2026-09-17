import type { DeviceModel } from './devices/driver.js';
import { cachedDiscoveryPaths, cachedDiscoverySerial } from './ffi/hid-discovery.js';
import { deviceKeyFor, sharedSerialModelId } from './device-identity.js';
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

/** Identity of a just-opened primary device: stable USB-serial key, else the
 *  (volatile) hidPath, else a per-model key (VID/PID-fallback open, no
 *  usage-matched path) — same rule as the extra-session path. */
export function resolveRealDeviceIdentity(
  hidPath: string | undefined,
  model: DeviceModel,
): { deviceKey: string; serial: string | null } {
  const serial = hidPath ? cachedDiscoverySerial(hidPath) : null;
  return {
    deviceKey: deviceKeyFor(hidPath ?? `model:${model.id}`, serial, sharedSerialModelId(model)),
    serial,
  };
}

export function defaultListModelPaths(model: DeviceModel): string[] {
  const { usagePage, usage } = model;
  return cachedDiscoveryPaths(model.usbVendorId, model.usbProductIds, usagePage, usage);
}
