import type { ChildGeometry, DeviceModel } from './driver.js';
import { modelToChildGeometry } from '../capabilities.js';
import { MK2_MODEL } from './elgato/mk2.js';
import { MINI_MODEL } from './elgato/mini.js';
import { MIRABOX_293_MODEL } from './mirabox/mirabox-293.js';
import { MIRABOX_293S_MODEL } from './mirabox/mirabox-293s.js';
import { MIRABOX_K1PRO_MODEL } from './mirabox/mirabox-k1pro.js';
import { AJAZZ_AKP153E_REV2_MODEL, AJAZZ_AKP153R_REV2_MODEL } from './ajazz/akp153-rev2.js';
import { AJAZZ_AKP05E_MODEL } from './ajazz/akp05e.js';
import { AJAZZ_AKP05_MODEL } from './ajazz/akp05.js';
import { FIFINE_D6_MODEL, FIFINE_D6_REV2_MODEL } from './fifine/fifine-d6.js';
import { AKP153_V1_CLONE_MODELS } from './rebadge/akp153-v1-clones.js';
import { STREAM_DECK_PLUS_MODEL } from './elgato/plus.js';

// Probe order: Elgato first (priority over Mirabox), then 293V3 before 293S. Everything
// after that has a unique VID/PID pair, so its position is cosmetic — the one near-clash,
// 0x5548 (293S vs. two v1 rebadges), is separated by PID.
export const DEVICE_MODELS: DeviceModel[] = [
  MK2_MODEL,
  MINI_MODEL,
  MIRABOX_293_MODEL,
  MIRABOX_293S_MODEL,
  MIRABOX_K1PRO_MODEL,
  AJAZZ_AKP05E_MODEL,
  AJAZZ_AKP05_MODEL,
  AJAZZ_AKP153E_REV2_MODEL,
  AJAZZ_AKP153R_REV2_MODEL,
  FIFINE_D6_MODEL,
  FIFINE_D6_REV2_MODEL,
  ...AKP153_V1_CLONE_MODELS,
];

/** Fallback model used when nothing is connected / before a real device is probed. */
export const DEFAULT_MODEL: DeviceModel = MK2_MODEL;

/** CORA emulation profiles: registry entries resolved as `cora.advertiseAs` targets
 *  only, never probed over USB. A device re-pairs as one of these by setting
 *  `cora.advertiseAs` (and matching `cora.productId`) via a model override. */
export const CORA_PROFILES: readonly DeviceModel[] = [STREAM_DECK_PLUS_MODEL];

/** Every resolvable model id: probeable devices + emulation profiles. */
const ALL_MODELS: readonly DeviceModel[] = [...DEVICE_MODELS, ...CORA_PROFILES];

/** The registry entry with this model id, or null. Model ids are the key of
 *  settings.json's `modelOverrides`, so this is the lookup that turns a persisted
 *  override back into the model it applies to. */
export function findModelById(id: string): DeviceModel | null {
  return ALL_MODELS.find((m) => m.id === id) ?? null;
}

/** Identifies which model matches a VID+PID pair, or null if unknown. */
export function findModel(vid: number, pid: number): DeviceModel | null {
  for (const model of DEVICE_MODELS) {
    if (model.usbVendorId === vid && model.usbProductIds.includes(pid)) {
      return model;
    }
  }
  return null;
}

/** The model whose geometry `model` emulates over CORA — itself unless it sets
 *  `cora.advertiseAs`. Resolved through registry ids, never copied dimensions, so an
 *  emulating model can't drift from the one it impersonates. device-models.test.ts
 *  asserts every `advertiseAs` resolves, so the throw is a can't-happen guard. */
function advertisedModel(model: DeviceModel): DeviceModel {
  if (!model.cora.advertiseAs) return model;
  const advertised = findModelById(model.cora.advertiseAs);
  if (!advertised) {
    throw new Error(`${model.id}: unknown advertised model '${model.cora.advertiseAs}'`);
  }
  return advertised;
}

export function advertisedGeometry(model: DeviceModel): ChildGeometry {
  return modelToChildGeometry(advertisedModel(model));
}
