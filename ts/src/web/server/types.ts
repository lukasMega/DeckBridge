import type {
  CommEntry,
  EncoderSettings,
  ExtraKeyConfig,
  DockStatus,
  RealDeviceIdentity,
  ClientApp,
  TouchStripMode,
} from '../../types.js';
import type {
  DeviceIdentity,
  DeviceModelInfo,
  KeyEventEntry,
  MockDeviceConfig,
  PluginsInfo,
  Stats,
  UpdateInfo,
} from '../contract.js';
import type { DeviceOverridesView } from './model-overrides-controller.js';
import type { OverrideChangeKind } from '../../devices/model-overrides.js';
import type { DiagnosticsOptions } from './diagnostics.js';
import type { PersistedSettings } from './persisted-settings.js';
import type { UpdateController } from './update-controller.js';
import type { DevicePrefsController } from './device-prefs-controller.js';
import type { ImageChannel } from './image-channel.js';
// Canonical LogLevel lives in logger.ts (derived from cli.ts's LOG_LEVELS);
// re-exported below so existing web-server call sites keep importing from types.js.
import type { LogLevel } from '../../logger.js';

/** Result of a persisted device-tuning change: how the live session applies it
 *  (see classifyOverrideChange). */
export interface OverrideChange {
  kind: OverrideChangeKind;
}

/** One POST to an extra key: a full widget config, or only its press command. */
export type ExtraKeyUpdate = ExtraKeyConfig | { pressCommand: string };

/** A rejected request: the message the WebUI shows, plus its HTTP status. */
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
  UpdateInfo,
} from '../contract.js';

export type { LogLevel };
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
  docks: DockStatus[];
  selectedDock: number;
}

export interface StateResponse extends StatusSnapshot {
  images: Record<string, number>;
  // Omitted from the wire payload in simple-only builds — see state-response.ts.
  logs?: LogEntry[];
  commLogs?: CommEntry[];
  keyEvents: KeyEventEntry[];
  stats: Stats;
  mockConfig: MockDeviceConfig;
  brightnessOverride: boolean;
  deviceModels: DeviceModelInfo[];
  deviceIdentity: DeviceIdentity;
  realDeviceIdentity?: RealDeviceIdentity;
  // The SELECTED dock's extra-key assignments, keyed by device wire id.
  extraKeys: Record<string, ExtraKeyConfig>;
  /** The SELECTED dock's touch-strip mode + knob override (AKP05E). */
  touchStripMode: TouchStripMode;
  touchStripRepaintMs: number;
  encoders: EncoderSettings;
  /** Log level currently in effect (not merely the persisted one) + where the
   *  log file lives — both surfaced under Settings so a reporter can turn on
   *  debug logging and find the file. */
  logLevel: string;
  logFilePath: string;
  /** Multi-deck opt-in (settings.json `multiDeck`). Read once per Settings-page
   *  mount, like logLevel — it is not in the status snapshot. */
  multiDeck: boolean;
  /** GitHub-release update check (update-check.ts) — cached, no network. */
  updateInfo: UpdateInfo;
}

/**
 * The narrow view of {@link WebUIServer} that HTTP route handlers depend on.
 * Handlers import this interface — never the concrete class — so routing stays
 * decoupled from server internals and there is no runtime import cycle.
 */
export interface WebUIController {
  emit(event: string, ...args: unknown[]): boolean;
  readonly brightnessOverride: boolean;
  readonly selectedDock: number;
  fullState(): StateResponse;
  getImage(key: number): Buffer | undefined;
  readonly imageChannel: Pick<ImageChannel, 'imageFormat'>;
  notifyBrightness(level: number): void;
  notifyBrightnessOverride(enabled: boolean): void;
  setBrowserLocale(locale: string): void;
  applyMockConfig(parsed: Partial<MockDeviceConfig>): MockDeviceConfig;
  trySimulateKey(n: number): ReqError | null;
  trySelectDock(index: unknown): ReqError | null;
  trySetExtraKey(wireId: number, update: ExtraKeyUpdate): ReqError | null;
  tryRunExtraKeyNow(wireId: number): ReqError | null;
  pluginsInfo(): Promise<PluginsInfo>;
  trySetTouchStripMode(mode: TouchStripMode): ReqError | null;
  trySetEncoders(settings: EncoderSettings): ReqError | null;
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
  readonly updates: UpdateController;
  readonly devicePrefs: DevicePrefsController;
}
