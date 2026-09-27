// DriverManager → ExtraDockCoordinator callbacks, split out of driver-manager-extras.ts
// to keep that file under the line-count cap.
import type { WorkerHidDriver } from '../worker/hid-worker-host.js';
import type { DeviceModel, DeviceModelOverride } from '../devices/driver.js';
import type { DriverMode } from './driver-manager-deps.js';
import type { HidDiscovery } from './driver-manager-discovery.js';
import type { WorkerPool } from './worker-pool.js';
import type { TouchWindowRegion, WidgetPaint } from '../shared/types.js';
import type { DockFrames, SessionServersFactory } from './device-session.js';
import type { PersistedSettings } from '../infra/settings.js';

export interface ExtraDockCoordinatorDeps {
  getShuttingDown: () => boolean;
  getDriverMode: () => DriverMode;
  isProbeInFlight: () => boolean;
  sessionServersFactory: SessionServersFactory | null;
  getRealDriver: () => WorkerHidDriver | null;
  /** Scan before each pass; per-unit paths drive docking of same-model duplicates. */
  discovery: HidDiscovery;
  /** Shared with the primary probe: a parked worker is reused, never respawned. */
  pool: WorkerPool;
  /** Registry model + the user's device tuning for it (settings.json
   *  modelOverrides), resolved by DriverManager. In safe mode
   *  (`--no-overrides`) `override` is undefined and `model` is the registry
   *  entry unchanged. */
  effectiveModelFor: (model: DeviceModel) => {
    model: DeviceModel;
    override?: DeviceModelOverride;
  };
  /** Per-device identity (getOrCreateIdentity) and live prefs (for) by deviceKey. */
  settings: Pick<PersistedSettings, 'for' | 'getOrCreateIdentity' | 'markPaired'>;
  /** A dock was created/torn down or its child CORA client (dis)connected;
   *  DriverManager notifies the WebUI. */
  onSessionsChanged?: () => void;
  /** An extra dock finished connecting (session.start() succeeded) — once per
   *  connect, for main/elgato-auto-restart.ts. */
  onDockConnected?: (dockIndex: number, deviceKey: string) => void;
  /** The Elgato child client attached to this extra dock — for
   *  main/elgato-auto-restart.ts's early-cancel path. */
  onElgatoAttached?: (dockIndex: number) => void;
  onAction?: (dockIndex: number, message: string) => void;
  /** Per-dock mirror of raw CORA key images (WebUI selected-dock preview). */
  onImage?: (dockIndex: number, keyIndex: number, data: Buffer, format: 'jpeg' | 'bmp') => void;
  /** WebUI strip + side-key preview mirrors; DeviceSession owns the device-side paint. */
  onTouchImage?: (dockIndex: number, data: Uint8Array, region?: TouchWindowRegion) => void;
  onWidgetPaint?: (dockIndex: number, wireId: number, paint: WidgetPaint | null) => void;
  onStripWrite?: (dockIndex: number, wireId: number, jpeg: Uint8Array, full: boolean) => void;
  /** This dock's cached CORA frames, for repainting after a live tuning swap. */
  dockFramesSnapshot?: (dockIndex: number) => DockFrames;
}
