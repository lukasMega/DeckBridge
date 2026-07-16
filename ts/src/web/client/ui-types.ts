// Duplicated from server-side DockStatus (../../types.ts) — web-client cannot
// import server/shared types (boundaries: web-client imports only web-client).
export interface DockUi {
  index: number;
  modelId: string;
  modelName: string;
  keyCount: number;
  columns: number;
  rows: number;
  primaryPort: number;
  primaryConnected: boolean; // primary (Network Dock) CORA client = app discovered us
  elgatoConnected: boolean;
  brightness?: number; // absent on legacy-synthesized entries (deriveDocks)
  extraKeys?: number[]; // wire ids of keys outside the emulated grid (293S 6th column)
}

// Duplicated from server-side ExtraKeyConfig (../../types.ts, see boundaries
// note above). One extra key's display-widget assignment (the keys have no
// switches — the server renders and refreshes them).
export type ExtraKeyWidget = 'none' | 'clock' | 'date' | 'text' | 'weather' | 'command' | 'plugin';

export interface ExtraKeyCfg {
  widget: ExtraKeyWidget;
  param?: string; // text: content; weather: "lat,lon"; plugin: plugin file name
  intervalMs?: number; // command/plugin widget: re-run/poll interval
  timeoutMs?: number; // command widget only: kill-timeout
  pluginArg?: string; // plugin widget only: per-key argument (ctx.param)
}

// Live status of one plugin-widget key — mirrors server-side PluginStatus
// (plugin-host.ts, reached via GET /api/plugins; see boundaries note above).
export type PluginStatus = 'pending' | 'ok' | 'err' | 'disabled';

// GET /api/plugins payload — mirrors server-side PluginsInfo (web/server/types.ts).
export interface PluginsInfo {
  dir: string;
  files: string[];
  status: Record<string, PluginStatus>;
}

// Which CORA client we detected — duplicated from server-side ClientApp
// (../../types.ts, see boundaries note above).
export type ClientApp = 'elgato' | 'bitfocus' | 'unknown';

export interface Status {
  driverMode: 'real' | 'mock';
  driverConnected: boolean;
  elgatoConnected: boolean;
  elgatoRemoteAddr?: string | null;
  clientApp?: ClientApp;
  keyCount?: number;
  columns?: number;
  brightness?: number;
  modelId?: string;
  modelName?: string;
  elgatoAppRunning?: boolean;
  elgatoDevicePresent?: boolean;
  localIp?: string;
  docks?: DockUi[];
  selectedDock?: number;
}

export interface Stats {
  uptimeMs: number;
  elgatoRxPkts: number;
  elgatoTxPkts: number;
  imagesSent: number;
}

export interface MockConfig {
  dockFirmwareVersion?: string;
  serialNumber?: string;
  childFirmwareVersion?: string;
  childSerialNumber?: string;
  productId?: number;
  macAddress?: string;
}

// The identifiers actually sent to the Elgato app for the currently active
// device (mock or real) — shown read-only under Settings.
export interface DeviceIdentity {
  dockFirmwareVersion: string;
  childFirmwareVersion: string;
  serialNumber: string;
  childSerialNumber: string;
  productId: number;
  macAddress: string;
  mdnsServiceName: string;
  // Present only for a real (non-mock) dock with a persisted identity — lets
  // the Settings page edit mdnsServiceName via POST /api/device-identity/mdns-name.
  deviceKey?: string;
}

export interface KeyEvent {
  ts: number;
  mk2Index: number;
  state: 'up' | 'down';
}
export interface ServerLog {
  ts: number;
  level: 'info' | 'warn' | 'error';
  component: string;
  message: string;
}
export interface CommLog {
  ts: number;
  direction: 'rx' | 'tx';
  protocol: string;
  human: string;
  hex?: string;
}
export interface DeviceModel {
  id: string;
  name: string;
  keyCount: number;
}
