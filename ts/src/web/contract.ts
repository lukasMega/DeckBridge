// WebUI wire contract: the `web-contract` leaf — DTOs sent over `/api/*` or the
// WS broadcast, nothing else. Zero imports, type-only edge, both tiers re-export
// from here. See "Architecture is lint-enforced" in CLAUDE.md.

/** 'elgato'/'bitfocus' are set only once a client-specific query is observed
 *  (elgato-server.ts / elgato-child-server.ts), 'unknown' otherwise. */
export type ClientApp = 'elgato' | 'bitfocus' | 'unknown';

export type KeyState = 'down' | 'up';

/** One extra key's display-widget assignment. `types.ts` holds the runtime
 *  `EXTRA_KEY_WIDGETS` list and proves it against this union with `satisfies`. */
export type ExtraKeyWidget = 'none' | 'clock' | 'date' | 'text' | 'weather' | 'command' | 'plugin';

/** Live status of one plugin-widget key (see plugin-host.ts). */
export type PluginStatus = 'pending' | 'ok' | 'err' | 'disabled';

/** GET /api/plugins: the plugins dir (empty-state hint), the *.js files found
 *  there (dropdown), and each plugin key's live status, keyed by wire id. */
export interface PluginsInfo {
  dir: string;
  files: string[];
  status: Record<string, PluginStatus>;
}

export interface Stats {
  uptimeMs: number;
  elgatoRxPkts: number;
  elgatoTxPkts: number;
  imagesSent: number;
}

export interface MockDeviceConfig {
  dockFirmwareVersion: string;
  childFirmwareVersion: string;
  serialNumber: string;
  childSerialNumber: string;
  productId: number;
  macAddress: string;
}

/** Identifiers actually sent to the Elgato app (mDNS + CORA device-info frames)
 *  for the active device: `mockConfig` while driverMode is 'mock', the real
 *  dock's fixed identity otherwise. Read-only, shown under Settings. */
export interface DeviceIdentity extends MockDeviceConfig {
  mdnsServiceName: string;
  // Present only for a real (non-mock) dock with a persisted identity — lets
  // the WebUI edit mdnsServiceName via POST /api/device-identity/mdns-name.
  deviceKey?: string;
}

/** Identity reported by the physical USB device. Absent in mock mode. */
export interface RealDeviceIdentity {
  modelName: string;
  serialNumber?: string;
  firmwareVersion?: string;
}

export interface KeyEventEntry {
  ts: number;
  mk2Index: number;
  state: KeyState;
  /** Raw wire id, pre-keyMap; absent for identity-mapped models and in mock mode.
   *  Key-map learn mode needs it: a wrong map is the thing being fixed, so the
   *  mapped index alone can't derive `wireInputToCora`. */
  wireId?: number;
}

export interface DeviceModelInfo {
  id: string;
  name: string;
  keyCount: number;
}
