import type {
  EncoderSettings,
  ExtraKeyConfig,
  DockStatus,
  TouchStripMode,
} from '../../shared/types.js';
import type {
  ExtraKeyPreviewResponse,
  ExtraKeyPressAction,
  MockDeviceConfig,
  PluginsInfo,
  StateResponse,
  DeviceOverridesView,
  WsBroadcast,
} from '../contract.js';
import type { OverrideChangeKind } from '../../devices/model-overrides.js';
import type { DiagnosticsOptions } from './diagnostics.js';
import type { PersistedSettings } from './persisted-settings.js';
import type { UpdateController } from './update-controller.js';
import type { DevicePrefsController } from './device-prefs-controller.js';
// Canonical LogLevel lives in logger.ts (derived from cli.ts's LOG_LEVELS);
// re-exported below so existing web-server call sites keep importing from types.js.
import type { LogLevel } from '../../shared/logger.js';

/** Result of a persisted device-tuning change: how the live session applies it
 *  (see classifyOverrideChange). */
export interface OverrideChange {
  kind: OverrideChangeKind;
}

/** One POST to an extra key: a full widget config, or only its press command. */
export type ExtraKeyUpdate = ExtraKeyConfig | ExtraKeyPressUpdate;

/** The press side of an extra key; an absent field keeps its stored value. */
export interface ExtraKeyPressUpdate {
  pressCommand?: string;
  pressAction?: ExtraKeyPressAction;
}

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
  broadcast: WsBroadcast;
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
  DriverMode,
  LogEntry,
  StatusSnapshot,
  StateResponse,
  DeviceOverridesView,
} from '../contract.js';

export type { LogLevel };

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
  notifyBrightness(level: number): void;
  notifyBrightnessOverride(enabled: boolean): void;
  setBrowserLocale(locale: string): void;
  applyMockConfig(parsed: Partial<MockDeviceConfig>): MockDeviceConfig;
  trySimulateKey(n: number): ReqError | null;
  trySelectDock(index: unknown): ReqError | null;
  trySetExtraKey(wireId: number, update: ExtraKeyUpdate): ReqError | null;
  tryRunExtraKeyNow(wireId: number): ReqError | null;
  tryPreviewExtraKey(wireId: number): ExtraKeyPreviewResponse | ReqError;
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
