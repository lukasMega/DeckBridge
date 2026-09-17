import type {
  CommEntry,
  ExtraKeyConfig,
  ImageModeOverride,
  DockStatus,
  RealDeviceIdentity,
  ClientApp,
} from '../../types.js';
import type {
  DeviceIdentity,
  DeviceModelInfo,
  KeyEventEntry,
  MockDeviceConfig,
  PluginsInfo,
  Stats,
} from '../contract.js';
import type { DeviceOverridesView } from './model-overrides-controller.js';
import type { OverrideChangeKind } from '../../devices/model-overrides.js';
import type { DiagnosticsOptions } from './diagnostics.js';
import type { PersistedSettings } from './persisted-settings.js';

/** A rejected request: the message the WebUI shows, plus its HTTP status. */
/** Result of a persisted device-tuning change: how the live session applies it
 *  (see classifyOverrideChange). */
export interface OverrideChange {
  kind: OverrideChangeKind;
}

export interface ReqError {
  error: string;
  status: number;
}

/** Shared guard for the WebUI's integer index/id fields (dock, wireId, …). */
export const isNonNegInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** The single wording every such field is rejected with — asserted verbatim by tests. */
export const nonNegIntMessage = (field: string): string =>
  `${field} must be a non-negative integer`;

export const nonNegIntError = (field: string): ReqError => ({
  error: nonNegIntMessage(field),
  status: 400,
});

/** The dependency set every WebUI controller needs: persisted settings, the two
 *  event sinks (WS broadcast / EventEmitter emit) and the selected-dock lookups.
 *  Built once by {@link WebUIServer} so a controller ctor carries only its own
 *  specific deps — see web-ui-server.ts's constructor. */
export interface ControllerHost {
  readonly settings: PersistedSettings;
  emit(event: string, ...args: unknown[]): boolean;
  broadcast(event: string, payload: unknown): void;
  selectedDeviceKey(): string;
  selectedDock(): number;
  selectedDockStatus(): DockStatus | undefined;
}

// Wire DTOs shared with the browser live in the `web-contract` leaf
// (../contract.ts); re-exported so server call sites keep importing from here.
export type {
  PluginsInfo,
  Stats,
  MockDeviceConfig,
  DeviceIdentity,
  KeyEventEntry,
  DeviceModelInfo,
} from '../contract.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type DriverMode = 'real' | 'mock';

export interface LogEntry {
  ts: number;
  level: LogLevel;
  component: string;
  message: string;
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
  /** True when the Elgato desktop app is running AND we do not hold the device —
   *  i.e. it is plausibly blocking us. NOT "the Elgato app is running": while
   *  DeckBridge is connected this is always false, app running or not. */
  elgatoAppConflict: boolean;
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
  realDeviceIdentity?: RealDeviceIdentity;
  // The SELECTED dock's extra-key assignments, keyed by device wire id.
  extraKeys: Record<string, ExtraKeyConfig>;
  /** Log level currently in effect (not merely the persisted one) + where the
   *  log file lives — both surfaced under Settings so a reporter can turn on
   *  debug logging and find the file. */
  logLevel: string;
  logFilePath: string;
  /** Multi-deck opt-in (settings.json `multiDeck`). Read once per Settings-page
   *  mount, like logLevel — it is not in the status snapshot. */
  multiDeck: boolean;
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
  trySimulateKey(n: number): ReqError | null;
  trySelectDock(index: unknown): ReqError | null;
  trySetExtraKey(wireId: number, cfg: ExtraKeyConfig): ReqError | null;
  tryRunExtraKeyNow(wireId: number): ReqError | null;
  pluginsInfo(): Promise<PluginsInfo>;
  getSettingsJson(): string;
  applySettingsJson(raw: string): void;
  openSettingsFile(): Promise<void>;
  trySetLogLevel(level: unknown): ReqError | null;
  setMultiDeck(enabled: boolean): void;
  openLogsFolder(): Promise<void>;
  deviceOverridesView(modelId?: unknown): DeviceOverridesView | ReqError;
  trySetModelOverride(modelId: unknown, overrides: unknown): ReqError | OverrideChange;
  tryResetModelOverride(modelId: unknown): ReqError | OverrideChange;
  buildDiagnosticsReport(opt?: DiagnosticsOptions): Promise<string>;
  saveDiagnosticsReport(opt?: DiagnosticsOptions): Promise<string | null>;
}
