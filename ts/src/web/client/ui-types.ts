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
  elgatoAppConflict?: boolean;
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

export interface RealDeviceIdentity {
  modelName: string;
  serialNumber?: string;
  firmwareVersion?: string;
}

export interface KeyEvent {
  ts: number;
  mk2Index: number;
  state: 'up' | 'down';
  /** Raw device wire id, pre-keyMap. Absent for identity-mapped models and in
   *  mock mode — key-map learn mode (keymap-learn.tsx) needs it to derive a
   *  correct map on hardware. */
  wireId?: number;
}

/** Tunable subset of a DeviceModel — mirrors server-side DeviceModelOverride
 *  (devices/driver.ts, see the boundaries note at the top of this file). Only
 *  the fields the Device tuning form exposes are typed here. */
export interface DeviceImageOverride {
  rotate?: 0 | 90 | 180 | 270;
  flipH?: boolean;
  flipV?: boolean;
  width?: number;
  height?: number;
  quality?: number;
  maxBytes?: number;
  blur?: number;
  sharpen?: number;
  crop?: number;
  resizeFilter?: 'triangle' | 'nearest' | 'lanczos3';
  resizeMode?: 'resize' | 'pad';
  padFill?: 'black' | 'average' | 'edge';
  transform?: 'passthrough' | 'sidecar';
}

/** `effective.image`: every tunable field, plus the protocol facts the device
 *  reports but no override may set. */
export interface DeviceEffectiveImage extends DeviceImageOverride {
  format?: 'jpeg' | 'bmp';
  colorMode?: 'rgb' | 'bgr';
  bmpPpm?: number;
}

export interface DeviceKeyMapOverride {
  coraToWireImage?: number[];
  wireInputToCora?: number[];
  inputOffset?: number;
  imageOffset?: number;
  extraKeys?: number[];
}

export interface DeviceModelOverride {
  image?: DeviceImageOverride;
  keyMap?: DeviceKeyMapOverride;
  wire?: Record<string, number | boolean>;
  splash?: unknown;
}

/** GET /api/device-overrides payload. */
export interface DeviceOverridesView {
  modelId: string;
  modelName: string;
  defaults: DeviceModelOverride;
  overrides: DeviceModelOverride;
  /** True when started with `--no-overrides`: tuning is stored but not in force. */
  safeMode?: boolean;
  /** Full effective spec — DISPLAY ONLY. Deliberately NOT typed as
   *  DeviceImageOverride: it carries the non-tunable protocol facts
   *  (`format`, `colorMode`, `bmpPpm`) as well, and posting those back is
   *  rejected by the server. Seed the form from `tunable`. */
  effective: { image: DeviceEffectiveImage; keyMap: DeviceKeyMapOverride };
  /** `effective` projected to the settable fields — what the form seeds from. */
  tunable: DeviceModelOverride;
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
