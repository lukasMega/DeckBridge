// The scalar status snapshot pushed to WS clients: driver/Elgato connection
// state, the active model's geometry, and the environment flags the simple UI
// branches on. Every mutator broadcasts; the flag setters dedupe first, because
// the 2 s reconnect scan calls them on every tick.
import { DEFAULT_MODEL } from '../../devices/registry.js';
import type { ClientApp, DockStatus, ImageModeOverride } from '../../types.js';
import type { DriverMode, StatusSnapshot } from './types.js';

/** The dock-list half of a snapshot, owned by DockRegistry/DevicePrefsController. */
export interface SnapshotExtras {
  brightness: number;
  imageModeOverride: ImageModeOverride;
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

  constructor(
    private readonly extras: () => SnapshotExtras,
    private readonly broadcast: (event: string, payload: unknown) => void,
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
    return { ...this.status, ...this.extras() };
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
