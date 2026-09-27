import type { ExtraKeyConfig, DockStatus } from '../../shared/types.js';
import type {
  ExtraKeyPressAction,
  MockDeviceConfig,
  StateResponse,
  WsBroadcast,
} from '../contract.js';
import type { OverrideChangeKind } from '../../devices/model-overrides.js';
import type { PersistedSettings } from '../../infra/settings.js';
import type { UpdateController } from './update-controller.js';
import type { DevicePrefsController } from './device-prefs-controller.js';
import type { EncodersController } from './encoders-controller.js';
import type { ExtraKeysController } from './extra-keys-controller.js';
import type { ModelOverridesController } from './model-overrides-controller.js';
import type { LoggingController } from './logging-controller.js';
import type { SettingsFileController } from './settings-file-controller.js';
import type { RawMockInput } from './mock-input.js';
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
  trySelectDock(index: unknown): ReqError | null;
  /** Re-push the selected dock's per-device values (none are in the status snapshot). */
  broadcastSelected(): void;
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
} from '../contract.js';

export type { LogLevel };

/** The per-concern WebUI controllers; route handlers get them on RouteContext. */
export interface WebUIControllers {
  readonly settings: PersistedSettings;
  readonly devicePrefs: DevicePrefsController;
  readonly encoders: EncodersController;
  readonly extraKeys: ExtraKeysController;
  readonly modelOverrides: ModelOverridesController;
  readonly logging: LoggingController;
  readonly updates: UpdateController;
  readonly settingsFile: SettingsFileController;
}

/**
 * What route handlers need from {@link WebUIServer} itself: state that spans
 * controllers (full state, dock selection, mock device). Handlers import this
 * interface — never the concrete class — so there is no runtime import cycle.
 */
export interface WebUIController {
  emit(event: string, ...args: unknown[]): boolean;
  readonly selectedDock: number;
  fullState(): StateResponse;
  notifyBrightness(level: number): void;
  applyMockConfig(parsed: Partial<MockDeviceConfig>): MockDeviceConfig;
  trySimulateKey(n: number): ReqError | null;
  trySimulateInput(raw: RawMockInput): ReqError | null;
  trySelectDock(index: unknown): ReqError | null;
}
