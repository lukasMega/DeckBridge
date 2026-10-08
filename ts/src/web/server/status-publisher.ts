// The scalar status snapshot pushed to WS clients: driver/Elgato connection
// state, the active model's geometry, and the environment flags the simple UI
// branches on. Every mutator broadcasts; the flag setters dedupe first, because
// the 3 s reconnect scan calls them on every tick.
import { DEFAULT_MODEL } from '../../devices/registry.js';
import type { ClientApp, DockStatus } from '../../shared/types.js';
import type { DriverMode, StatusSnapshot } from './types.js';
import type { WsBroadcast } from '../contract.js';

/** The dock-list half of a snapshot, owned by DockRegistry/DevicePrefsController. */
export interface SnapshotExtras {
  brightness: number;
  docks: DockStatus[];
  selectedDock: number;
}

type StatusFlag = 'clientApp' | 'elgatoAppConflict' | 'elgatoDevicePresent';

export class StatusPublisher {
  private readonly status = {
    driverMode: 'real' as DriverMode,
    driverConnected: false,
    elgatoConnected: false,
    elgatoRemoteAddr: null as string | null,
    clientApp: 'unknown' as ClientApp,
    modelId: DEFAULT_MODEL.id,
    modelName: DEFAULT_MODEL.name,
    keyCount: DEFAULT_MODEL.keyCount,
    columns: DEFAULT_MODEL.columns,
    rows: DEFAULT_MODEL.rows,
    elgatoAppConflict: false,
    elgatoDevicePresent: false,
    localIp: '127.0.0.1',
  };

  /** Server-epoch deadline; only ever sent as `remainingMs` (see snapshot()). */
  private autoRestart: { at: number; docks: number[] } | null = null;

  constructor(
    private readonly extras: () => SnapshotExtras,
    private readonly broadcast: WsBroadcast,
    initialDriverMode: DriverMode = 'real',
  ) {
    this.status.driverMode = initialDriverMode;
  }

  get driverMode(): DriverMode {
    return this.status.driverMode;
  }

  get modelId(): string {
    return this.status.modelId;
  }

  get keyCount(): number {
    return this.status.keyCount;
  }

  snapshot(): StatusSnapshot {
    // Relative, computed at serialization: a browser with a skewed clock must
    // never compare a server epoch to its own Date.now().
    const pending = this.autoRestart;
    return {
      ...this.status,
      ...this.extras(),
      elgatoAutoRestartPending: pending
        ? { remainingMs: Math.max(0, pending.at - Date.now()), docks: [...pending.docks] }
        : null,
    };
  }

  publish(): void {
    this.broadcast('status', this.snapshot());
  }

  setLocalIp(ip: string): void {
    this.status.localIp = ip;
  }

  setDriverStatus(mode: DriverMode, connected: boolean): void {
    this.status.driverMode = mode;
    this.status.driverConnected = connected;
    this.publish();
  }

  setElgatoStatus(connected: boolean, remoteAddr?: string): void {
    this.status.elgatoConnected = connected;
    this.status.elgatoRemoteAddr = remoteAddr ?? null;
    if (!connected) this.status.clientApp = 'unknown';
    this.publish();
  }

  /** Set a flag + broadcast, only if changed. */
  setFlag<K extends StatusFlag>(key: K, value: (typeof this.status)[K]): void {
    if (this.status[key] === value) return;
    this.status[key] = value;
    this.publish();
  }

  /** Dedupes on deadline + dock set; a joining dock re-publishes the same deadline. */
  setAutoRestart(next: { at: number; docks: readonly number[] } | null): void {
    const prev = this.autoRestart;
    const same =
      prev === next ||
      (prev !== null &&
        next !== null &&
        prev.at === next.at &&
        prev.docks.length === next.docks.length &&
        prev.docks.every((d, i) => d === next.docks[i]));
    if (same) return;
    this.autoRestart = next && { at: next.at, docks: [...next.docks] };
    this.publish();
  }

  setDeviceModel(model: {
    id: string;
    name: string;
    keyCount: number;
    columns: number;
    rows: number;
  }): void {
    const { id: modelId, name: modelName, ...rest } = model;
    Object.assign(this.status, { modelId, modelName, ...rest });
    this.publish();
  }
}
