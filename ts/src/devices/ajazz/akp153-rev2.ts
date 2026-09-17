import type { DeviceModel } from '../driver.js';
import { MIRABOX_293_MODEL } from '../mirabox/mirabox-293.js';

/** Ajazz AKP153E / AKP153R **rev. 2** — the Mirabox 293V3 protocol behind a different
 * VID/PID (`0x0300:0x3010` / `0x3011`). Shared defaults come from MIRABOX_293_MODEL; AKP153E
 * hardware-calibrated geometry and mapping override them below. AKP153R remains untested. Rev. */
const AKP153_REV2_BASE = {
  ...MIRABOX_293_MODEL,
  vendor: 'ajazz',
  usbVendorId: 0x0300,
} satisfies DeviceModel;

export const AJAZZ_AKP153E_REV2_MODEL: DeviceModel = {
  ...AKP153_REV2_BASE,
  id: 'ajazz-akp153e-rev2',
  name: 'Ajazz AKP153E (rev. 2)',
  usbProductIds: [0x3010],
  keyWidth: 95,
  keyHeight: 95,
  image: {
    ...AKP153_REV2_BASE.image,
    width: 95,
    height: 95,
    rotate: 90,
  },
  keyMap: {
    // Confirmed on Windows hardware in issue #67: image IDs and input codes share
    // the same column-major namespace, so these maps are exact inverses.
    coraToWireImage: [13, 10, 7, 4, 1, 14, 11, 8, 5, 2, 15, 12, 9, 6, 3],
    wireInputToCora: [-1, 4, 9, 14, 3, 8, 13, 2, 7, 12, 1, 6, 11, 0, 5, 10],
  },
};

export const AJAZZ_AKP153R_REV2_MODEL: DeviceModel = {
  ...AKP153_REV2_BASE,
  id: 'ajazz-akp153r-rev2',
  name: 'Ajazz AKP153R (rev. 2)',
  usbProductIds: [0x3011],
};
