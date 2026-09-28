// DriverManager → DockScanner callbacks, split out of dock-scanner.ts
// to keep that file under the line-count cap.
import type { DeviceModel, DeviceModelOverride } from '../devices/driver.js';
import type { DriverMode } from './driver-manager-deps.js';
import type { HidDiscovery } from './driver-manager-discovery.js';
import type { WorkerPool } from './worker-pool.js';
import type { DockSlot } from './dock-status.js';
import type { CoraDock } from './cora-dock.js';
import type { Dock, DockHooks, DockSettings } from './dock.js';

/** Builds a dock's CORA server pair (already wrapped as a CoraDock — see
 *  cora-dock.ts) for the given identity; the factory (wired in app.ts) is what
 *  constructs the servers with the identity's ports/serials. */
export type CoraDockFactory = (identity: DockSlot) => CoraDock;

/** What the scan needs of dock 0's driver (hidPath: WorkerHidDriver only). */
export interface PrimaryUnit {
  readonly model: DeviceModel;
  readonly hidPath?: string;
}

export interface DockScannerDeps {
  /** DriverManager's dock map: scanned docks are added/removed here by index. */
  docks: Map<number, Dock>;
  getShuttingDown: () => boolean;
  getDriverMode: () => DriverMode;
  isProbeInFlight: () => boolean;
  coraDockFactory: CoraDockFactory | null;
  /** Dock 0's USB unit in real mode (null otherwise): its path is claimed, and a
   *  unit opened without a path makes its whole model unclaimable. */
  getRealDriver: () => PrimaryUnit | null;
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
  settings: DockSettings;
  /** The WebUI mirror + status hooks for the dock at `index`. */
  dockHooks: (index: number) => DockHooks;
  /** A dock was created/torn down (DriverManager's 'changed'). */
  onChanged: () => void;
  /** An scanned dock finished connecting (dock.start() succeeded) — once per
   *  connect, for main/elgato-auto-restart.ts. */
  onDockConnected?: (dockIndex: number, deviceKey: string) => void;
}
