import type { DeviceModel, DeviceVendor } from '../driver.js';
import { MIRABOX_K1PRO_MODEL } from '../mirabox/mirabox-k1pro.js';

/** `[id, name, vendor, usbVendorId, usbProductId]` — the only fields a rebadge changes. */
type CloneSpec = readonly [string, string, DeviceVendor, number, number];

const K1PRO_CLONE_SPECS: readonly CloneSpec[] = [
  // Issue #252: enumerates as "HOTSPOTEKUSB Keyboard", usage page 0xffa0 on interface 1.
  ['mirabox-k1pro-5548', 'Mirabox K1 Pro (0x5548)', 'mirabox', 0x5548, 0x1025],
];

function cloneOfK1Pro([id, name, vendor, vid, pid]: CloneSpec): DeviceModel {
  return { ...MIRABOX_K1PRO_MODEL, id, name, vendor, usbVendorId: vid, usbProductIds: [pid] };
}

/** K1 Pro boards under another VID/PID. NOT HARDWARE-TESTED: everything except identity is
 *  inherited from MIRABOX_K1PRO_MODEL. 0x5548:0x1025 sits next to the AKP05-family PIDs
 *  0x1021/0x1023 (see ../PROVENANCE.md), so the protocol is a guess until a user confirms. */
export const K1PRO_CLONE_MODELS: readonly DeviceModel[] = K1PRO_CLONE_SPECS.map(cloneOfK1Pro);
