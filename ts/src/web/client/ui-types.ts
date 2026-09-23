// Wire DTOs live in the `web-contract` leaf (../contract.ts) — the one element
// web-client may import besides itself, type-only. Re-exported here under the
// names the client already uses, so call sites keep importing from ui-types.
import type { ClientApp, ExtraKeyWidget } from '../contract.js';

export type {
  ClientApp,
  EncoderCommands,
  EncoderSettings,
  ExtraKeyWidget,
  PluginStatus,
  PluginsInfo,
  Stats,
  DeviceIdentity,
  RealDeviceIdentity,
  KeyEventEntry as KeyEvent,
  DeviceModelInfo as DeviceModel,
  TouchStripMode,
  UpdateInfo,
} from '../contract.js';

export interface TouchStripSize {
  width: number;
  height: number;
}

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
  pressableExtraKeys?: number[]; // the extraKeys with a switch (AKP05E right column as a Plus)
  widgetDisplays?: Array<{ wireId: number; label: string }>;
  encoderCount?: number; // rotary encoders (knobs); absent/0 = none
  coraProfile?: string; // re-paired CORA profile (cora.advertiseAs); absent = native
  touchStripSize?: TouchStripSize; // advertised strip (Plus: 800×100)
}

export interface ExtraKeyCfg {
  widget: ExtraKeyWidget;
  param?: string; // text: content; weather: "lat,lon"; plugin: plugin file name
  intervalMs?: number; // command/plugin widget: re-run/poll interval
  timeoutMs?: number; // command widget only: kill-timeout
  pluginArg?: string; // plugin widget only: per-key argument (ctx.param)
  pressCommand?: string; // pressable extra keys only: shell command run on press
}

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

export interface MockConfig {
  dockFirmwareVersion?: string;
  serialNumber?: string;
  childFirmwareVersion?: string;
  childSerialNumber?: string;
  productId?: number;
  macAddress?: string;
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

export interface DeviceCoraOverride {
  advertiseAs?: string;
  productId?: number;
}

export interface DeviceModelOverride {
  image?: DeviceImageOverride;
  keyMap?: DeviceKeyMapOverride;
  wire?: Record<string, number | boolean>;
  splash?: unknown;
  cora?: DeviceCoraOverride;
}

/** A CORA emulation profile the device may re-pair as (from CORA_PROFILES). */
export interface EmulationProfile {
  id: string;
  name: string;
  productId: number;
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
  /** Emulation profiles a device may re-pair as. */
  profiles?: EmulationProfile[];
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
