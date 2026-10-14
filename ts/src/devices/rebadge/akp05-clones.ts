import type { DeviceModel, DeviceVendor } from '../driver.js';
import { AJAZZ_AKP05E_MODEL } from '../ajazz/akp05e.js';

/** `[id, name, vendor, usbVendorId, usbProductId]` — the only fields a clone changes. */
type CloneSpec = readonly [string, string, DeviceVendor, number, number];

const AKP05_CLONE_SPECS: readonly CloneSpec[] = [
  ['redragon-ss552', 'Redragon SS552', 'redragon', 0x0200, 0x3001],
  ['mirabox-n4', 'Mirabox N4', 'mirabox', 0x6602, 0x1001],
  ['mirabox-n4e', 'Mirabox N4E', 'mirabox', 0x6603, 0x1007],
  ['mirabox-n4-pro', 'Mirabox N4 Pro', 'mirabox', 0x5548, 0x1008],
  ['mirabox-n4-pro-e', 'Mirabox N4 Pro E', 'mirabox', 0x5548, 0x1021],
  ['vsdinside-n4', 'VSDinside N4', 'vsdinside', 0x5548, 0x1004],
  ['vsdinside-n4-pro', 'VSDinside N4 Pro', 'vsdinside', 0x5548, 0x1023],
  ['mars-msd-pro', 'Mars Gaming MSD-PRO', 'mars-gaming', 0x0b00, 0x1003],
  ['soomfon-cn003', 'Soomfon CN003', 'soomfon', 0x1500, 0x3002],
  ['streonor-s10-pro', 'Streonor S10 Pro', 'streonor', 0x1500, 0x3007],
  ['ajazz-akp05e-pro', 'AJAZZ AKP05E Pro', 'ajazz', 0x0300, 0x3013],
  ['ajazz-akp05cn-pro', 'AJAZZ AKP05CN Pro', 'ajazz', 0x0300, 0x3014],
];

function cloneOfAkp05E([id, name, vendor, vid, pid]: CloneSpec): DeviceModel {
  return { ...AJAZZ_AKP05E_MODEL, id, name, vendor, usbVendorId: vid, usbProductIds: [pid] };
}

/** AKP05 boards sold under other VID/PIDs. NOT HARDWARE-TESTED: every field except
 *  identity is inherited from AJAZZ_AKP05E_MODEL, and the IDs come from opendeck-akp05
 *  `src/mappings.rs`. The one open geometry question (SS552 touch strip) and the
 *  adjacent-PID traps are in ../PROVENANCE.md. */
export const AKP05_CLONE_MODELS: readonly DeviceModel[] = AKP05_CLONE_SPECS.map(cloneOfAkp05E);
