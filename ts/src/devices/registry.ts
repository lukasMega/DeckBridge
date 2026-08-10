import type { DeviceModel } from './driver.js';
import { MK2_MODEL } from './elgato/mk2.js';
import { MINI_MODEL } from './elgato/mini.js';
import { MIRABOX_293_MODEL } from './mirabox/mirabox-293.js';
import { MIRABOX_293S_MODEL } from './mirabox/mirabox-293s.js';
import { MIRABOX_K1PRO_MODEL } from './mirabox/mirabox-k1pro.js';
import { AJAZZ_AKP153E_REV2_MODEL, AJAZZ_AKP153R_REV2_MODEL } from './ajazz/akp153-rev2.js';

// Elgato models first so they take priority over Mirabox in the probe loop.
// 293V3 before 293S within Mirabox (existing device probed first).
// Ajazz last — its VID (0x0300) is unique, so probe order doesn't matter for it.
export const DEVICE_MODELS: DeviceModel[] = [
  MK2_MODEL,
  MINI_MODEL,
  MIRABOX_293_MODEL,
  MIRABOX_293S_MODEL,
  MIRABOX_K1PRO_MODEL,
  AJAZZ_AKP153E_REV2_MODEL,
  AJAZZ_AKP153R_REV2_MODEL,
];

/** Fallback model used when nothing is connected / before a real device is probed. */
export const DEFAULT_MODEL: DeviceModel = MK2_MODEL;

/** Identifies which model matches a VID+PID pair, or null if unknown. */
export function findModel(vid: number, pid: number): DeviceModel | null {
  for (const model of DEVICE_MODELS) {
    if (model.usbVendorId === vid && model.usbProductIds.includes(pid)) {
      return model;
    }
  }
  return null;
}
