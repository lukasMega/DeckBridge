// USB workers by model id. A worker whose open() failed is parked, not
// terminated: spawn/terminate per retry SIGBUSes on macOS, and a parked worker
// connects the moment open() succeeds. Shared by the primary probe and extras.
import { WorkerHidDriver, closeDriver } from '../worker/hid-worker-host.js';
import type { DeviceModel, DeviceModelOverride } from '../devices/driver.js';

export type WorkerFactory = (model: DeviceModel, override?: DeviceModelOverride) => WorkerHidDriver;

export class WorkerPool {
  private readonly idle = new Map<string, WorkerHidDriver>();

  constructor(
    private readonly make: WorkerFactory = (model, ov) => new WorkerHidDriver(model, ov),
  ) {}

  /** The worker parked for `model.id`, else a fresh one (`fresh`: needs listeners). */
  acquire(
    model: DeviceModel,
    override?: DeviceModelOverride,
  ): { driver: WorkerHidDriver; fresh: boolean } {
    const parked = this.idle.get(model.id);
    if (parked) {
      this.idle.delete(model.id);
      return { driver: parked, fresh: false };
    }
    return { driver: this.make(model, override), fresh: true };
  }

  park(modelId: string, driver: WorkerHidDriver): void {
    this.idle.set(modelId, driver);
  }

  setLogLevel(level: string): void {
    for (const d of this.idle.values()) d.setLogLevel(level);
  }

  /** One-off terminate (mode switch), off the hot retry loop. */
  async closeAll(): Promise<void> {
    for (const d of this.idle.values()) await closeDriver(d);
    this.idle.clear();
  }
}
