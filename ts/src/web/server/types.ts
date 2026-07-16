import type {
  KeyState,
  CommEntry,
  ExtraKeyConfig,
  ImageModeOverride,
  DockStatus,
  ClientApp,
} from '../../types.js';
import type { PluginStatus } from '../../plugin-host.js';

/** Payload for GET /api/plugins — the extra-key plugin widget's WebUI data:
 *  the plugins dir (for the empty-state hint), the *.js files found there
 *  (dropdown), and the live status of each plugin-widget key on the selected
 *  dock (keyed by wire id). */
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

/** The identifiers actually sent to the Elgato Stream Deck app over the
 *  network (mDNS advertisement + CORA device-info/capabilities frames) for
 *  whichever device is currently active — `mockConfig` while driverMode is
 *  'mock', the real dock's fixed identity otherwise. Read-only, shown under
 *  Settings for reference. */
export interface DeviceIdentity extends MockDeviceConfig {
  mdnsServiceName: string;
  // Present only for a real (non-mock) dock with a persisted identity — lets
  // the WebUI edit mdnsServiceName via POST /api/device-identity/mdns-name.
  deviceKey?: string;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type DriverMode = 'real' | 'mock';

export interface LogEntry {
  ts: number;
  level: LogLevel;
  component: string;
  message: string;
}

export interface KeyEventEntry {
  ts: number;
  mk2Index: number;
  state: KeyState;
}

export interface DeviceModelInfo {
  id: string;
  name: string;
  keyCount: number;
}

export interface StatusSnapshot {
  driverMode: DriverMode;
  driverConnected: boolean;
  elgatoConnected: boolean;
  elgatoRemoteAddr: string | null;
  clientApp: ClientApp;
  brightness: number;
  modelId: string;
  modelName: string;
  keyCount: number;
  columns: number;
  rows: number;
  elgatoAppRunning: boolean;
  /** True when an Elgato-branded device (MK.2/Mini) is enumerated on USB —
   *  independent of whether we could open it. Gates the "Elgato app is
   *  blocking access" screen so it doesn't fire for non-Elgato hardware. */
  elgatoDevicePresent: boolean;
  localIp: string;
  imageModeOverride: ImageModeOverride;
  docks: DockStatus[];
  selectedDock: number;
}

export interface StateResponse extends StatusSnapshot {
  images: Record<string, number>;
  logs: LogEntry[];
  commLogs: CommEntry[];
  keyEvents: KeyEventEntry[];
  stats: Stats;
  mockConfig: MockDeviceConfig;
  resizeEnabled: boolean;
  brightnessOverride: boolean;
  deviceModels: DeviceModelInfo[];
  deviceIdentity: DeviceIdentity;
  // The SELECTED dock's extra-key assignments, keyed by device wire id.
  extraKeys: Record<string, ExtraKeyConfig>;
}

/**
 * The narrow view of {@link WebUIServer} that HTTP route handlers depend on.
 * Handlers import this interface — never the concrete class — so routing stays
 * decoupled from server internals and there is no runtime import cycle.
 */
export interface WebUIController {
  emit(event: string, ...args: unknown[]): boolean;
  readonly resizeEnabled: boolean;
  readonly brightnessOverride: boolean;
  readonly imageModeOverride: ImageModeOverride;
  readonly selectedDock: number;
  fullState(): StateResponse;
  getImage(key: number): Buffer | undefined;
  notifyBrightness(level: number): void;
  notifyResizeToggle(enabled: boolean): void;
  notifyBrightnessOverride(enabled: boolean): void;
  notifyImageMode(mode: ImageModeOverride): void;
  applyMockConfig(parsed: Partial<MockDeviceConfig>): MockDeviceConfig;
  trySimulateKey(n: number): { error: string; status: number } | null;
  trySelectDock(index: unknown): { error: string; status: number } | null;
  trySetExtraKey(wireId: number, cfg: ExtraKeyConfig): { error: string; status: number } | null;
  tryRunExtraKeyNow(wireId: number): { error: string; status: number } | null;
  pluginsInfo(): Promise<PluginsInfo>;
  getSettingsJson(): string;
  applySettingsJson(raw: string): void;
  openSettingsFile(): Promise<void>;
}
