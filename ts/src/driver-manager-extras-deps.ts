// DriverManager → ExtraDockCoordinator callbacks, split out of driver-manager-extras.ts
// to keep that file under the line-count cap.
import type { WorkerHidDriver } from './hid-worker-host.js';
import type { DeviceModel, DeviceModelOverride } from './devices/driver.js';
import type { DriverMode } from './driver-manager-discovery.js';
import type {
  EncoderSettings,
  ExtraKeyConfig,
  TouchStripMode,
  TouchWindowRegion,
  WidgetPaint,
} from './types.js';
import type { DockFrames, SessionServersFactory } from './device-session.js';
import type { DeviceIdentitySettings } from './settings-store.js';

export interface ExtraDockCoordinatorDeps {
  getShuttingDown: () => boolean;
  getDriverMode: () => DriverMode;
  isProbeInFlight: () => boolean;
  sessionServersFactory: SessionServersFactory | null;
  getRealDriver: () => WorkerHidDriver | null;
  /** Refresh supported HID paths off-thread before each discovery pass. */
  refreshHidSnapshot: () => Promise<number>;
  /** Every connected HID interface path for this model (one per physical unit),
   *  from deckbridge-native enumeration. Drives per-unit docking of same-model
   *  duplicates. [] when absent or the model can't be path-targeted. */
  listModelPaths: (model: DeviceModel) => string[];
  /** Serial lookup from the completed discovery snapshot. Never enumerates. */
  serialForPath: (hidPath: string) => string | null;
  /** Registry model + the user's device tuning for it (settings.json
   *  modelOverrides), resolved by DriverManager. In safe mode
   *  (`--no-overrides`) `override` is undefined and `model` is the registry
   *  entry unchanged. */
  effectiveModelFor: (model: DeviceModel) => {
    model: DeviceModel;
    override?: DeviceModelOverride;
  };
  makeRealDriver: (model: DeviceModel, override?: DeviceModelOverride) => WorkerHidDriver;
  /** Reuse (or vend) the idle worker parked for this model.id, mirroring the
   *  primary probe's idleDrivers pattern — shared with DriverManager via
   *  these two callbacks rather than a second map. */
  takeIdleDriver: (modelId: string) => WorkerHidDriver | undefined;
  parkIdleDriver: (modelId: string, driver: WorkerHidDriver) => void;
  /** Look up (or generate + persist) the stable per-physical-device identity
   *  for `deviceKey` — delegates to WebUIServer, the sole settings.json
   *  writer (device-identity.ts is pure). */
  getOrCreateDeviceIdentity: (deviceKey: string, defaultMdnsName: string) => DeviceIdentitySettings;
  /** A dock was created/torn down or its child CORA client (dis)connected;
   *  DriverManager notifies the WebUI. */
  onSessionsChanged?: () => void;
  onAction?: (dockIndex: number, message: string) => void;
  /** Per-dock mirror of raw CORA key images (WebUI selected-dock preview). */
  onImage?: (dockIndex: number, keyIndex: number, data: Buffer, format: 'jpeg' | 'bmp') => void;
  /** WebUI strip + side-key preview mirrors; DeviceSession owns the device-side paint. */
  onTouchImage?: (dockIndex: number, data: Uint8Array, region?: TouchWindowRegion) => void;
  onWidgetPaint?: (dockIndex: number, wireId: number, paint: WidgetPaint | null) => void;
  onStripWrite?: (dockIndex: number, wireId: number, jpeg: Uint8Array, full: boolean) => void;
  /** This dock's cached CORA frames, for repainting after a live tuning swap. */
  dockFramesSnapshot?: (dockIndex: number) => DockFrames;
  /** Per-device "ignore brightness from Elgato app" override, resolved by the
   *  dock's deviceKey (each dock has its own persisted flag). */
  isBrightnessOverride: (deviceKey: string) => boolean;
  /** Per-device extra-key config (293S 6th column), resolved by deviceKey +
   *  wire id — delegates to WebUIServer's persisted settings. */
  extraKeyConfigFor: (deviceKey: string, wireId: number) => ExtraKeyConfig | undefined;
  /** Per-device touch-strip mode + encoder override, resolved live by deviceKey. */
  touchStripModeFor: (deviceKey: string) => TouchStripMode;
  touchStripRepaintMsFor: (deviceKey: string) => number;
  encoderSettingsFor: (deviceKey: string) => EncoderSettings | undefined;
}
