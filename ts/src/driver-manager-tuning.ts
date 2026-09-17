// How a persisted device-tuning change reaches the running device(s). Split out
// of driver-manager.ts, which keeps the connection lifecycle: this module only
// decides live-swap vs reopen and drives the two paths.
import { log } from './logger.js';
import { applyModelOverrides } from './devices/model-overrides.js';
import type { OverrideChangeKind } from './devices/model-overrides.js';
import { findModelById } from './devices/registry.js';
import type { DeviceDriver, DeviceModel, DeviceModelOverride } from './devices/driver.js';
import type { WorkerHidDriver } from './hid-worker-host.js';
import type { PrimaryDock } from './driver-manager-primary.js';
import type { DriverMode } from './driver-manager-discovery.js';

/** The slice of DriverManager this module drives. `reopenSession` is the
 *  manager's own teardown (clear driver state, notify, close, reschedule) —
 *  lifecycle stays there. */
export interface TuningContext {
  primary: PrimaryDock;
  extras: {
    applyLiveDeviceTuning: (modelId: string) => void;
    reloadDeviceTuning: (modelId: string) => Promise<void>;
  };
  driverMode: DriverMode;
  currentDriver: DeviceDriver | null;
  realDriver: WorkerHidDriver | null;
  overrideFor: (modelId: string) => DeviceModelOverride | undefined;
  connectMock: (model: DeviceModel) => Promise<void>;
  reopenSession: (driver: WorkerHidDriver) => Promise<void>;
}

/** Image-only change: patch every live dock in place. No status flap and no
 *  dock-change event — nothing changed but the spec images are encoded with. */
function applyLive(ctx: TuningContext, modelId: string): void {
  ctx.extras.applyLiveDeviceTuning(modelId);
  const driver = ctx.currentDriver;
  if (!driver || (modelId && driver.model.id !== modelId)) return;
  // From the REGISTRY entry, not driver.model: re-merging over an already merged
  // model would keep a value the user has just cleared.
  const registryModel = findModelById(driver.model.id);
  if (!registryModel) return;
  const override = ctx.overrideFor(registryModel.id);
  log('info', 'driverMgr', `applying device tuning live to ${registryModel.id}`);
  ctx.primary.applyLiveTuning(driver, override, applyModelOverrides(registryModel, override));
}

/** Apply a persisted tuning change to the live session(s). `modelId` '' means
 *  "every model"; `kind` comes from classifyOverrideChange. */
export async function applyTuningChange(
  ctx: TuningContext,
  modelId: string,
  kind: OverrideChangeKind,
): Promise<void> {
  if (kind === 'none') return;
  if (kind === 'live') {
    applyLive(ctx, modelId);
    return;
  }
  if (ctx.driverMode === 'mock') {
    if (ctx.currentDriver) await ctx.connectMock(ctx.currentDriver.model);
    return;
  }
  await ctx.extras.reloadDeviceTuning(modelId);
  const driver = ctx.realDriver;
  if (!driver || (modelId && driver.model.id !== modelId)) return;
  log('info', 'driverMgr', `reopening ${driver.model.id} to apply device tuning`);
  await ctx.reopenSession(driver);
}
