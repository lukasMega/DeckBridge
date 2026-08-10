import type { DeviceModel } from './driver.js';
import { MK2_MODEL } from './elgato/mk2.js';
import { MINI_MODEL } from './elgato/mini.js';
import { MIRABOX_293_MODEL } from './mirabox/mirabox-293.js';
import { MIRABOX_293S_MODEL } from './mirabox/mirabox-293s.js';
import { MIRABOX_K1PRO_MODEL } from './mirabox/mirabox-k1pro.js';
import { AJAZZ_AKP153E_REV2_MODEL, AJAZZ_AKP153R_REV2_MODEL } from './ajazz/akp153-rev2.js';
import {
  AJAZZ_AKP153_MODEL,
  AJAZZ_AKP153E_MODEL,
  AJAZZ_AKP153R_MODEL,
  MARS_MSD_ONE_MODEL,
  MADDOG_GK150K_MODEL,
  RISEMODE_VISION_01_MODEL,
  TMICE_STREAM_CONTROLLER_MODEL,
} from './rebadge/akp153-v1-clones.js';

// Elgato models first so they take priority over Mirabox in the probe loop.
// 293V3 before 293S within Mirabox (existing device probed first).
// Ajazz rev. 2 next — its VID (0x0300) is unique among the v3 models.
// The 7 v1 rebadges (akp153-v1-clones.ts) last — probe order is irrelevant for them,
// every VID is unique except 0x5548 (shared with the 293S, but PIDs 0x6670/0x6674 don't
// overlap).
export const DEVICE_MODELS: DeviceModel[] = [
  MK2_MODEL,
  MINI_MODEL,
  MIRABOX_293_MODEL,
  MIRABOX_293S_MODEL,
  MIRABOX_K1PRO_MODEL,
  AJAZZ_AKP153E_REV2_MODEL,
  AJAZZ_AKP153R_REV2_MODEL,
  AJAZZ_AKP153_MODEL,
  AJAZZ_AKP153E_MODEL,
  AJAZZ_AKP153R_MODEL,
  MARS_MSD_ONE_MODEL,
  MADDOG_GK150K_MODEL,
  RISEMODE_VISION_01_MODEL,
  TMICE_STREAM_CONTROLLER_MODEL,
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
