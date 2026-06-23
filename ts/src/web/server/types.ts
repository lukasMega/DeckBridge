import type { KeyState, CommEntry, ImageModeOverride } from '../../types.js';

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
  brightness: number;
  modelId: string;
  modelName: string;
  keyCount: number;
  columns: number;
  rows: number;
  elgatoAppRunning: boolean;
  localIp: string;
  imageModeOverride: ImageModeOverride;
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
  fullState(): StateResponse;
  getImage(key: number): Buffer | undefined;
  notifyBrightness(level: number): void;
  notifyResizeToggle(enabled: boolean): void;
  notifyBrightnessOverride(enabled: boolean): void;
  notifyImageMode(mode: ImageModeOverride): void;
  applyMockConfig(parsed: Partial<MockDeviceConfig>): MockDeviceConfig;
  trySimulateKey(n: number): { error: string; status: number } | null;
}
