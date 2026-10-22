import type { DeviceModel } from '../driver.js';
import { MIRABOX_293_MODEL } from '../mirabox/mirabox-293.js';
import { ELGATO_MK2_PID } from '../../shared/types.js';

/** upHere 293V3: rebadge of the Mirabox 293V3 board (JIB drives it with the SDK's StreamDock293V3 class), scaffolded from `mirabox-293`.
 *  NOT HARDWARE-TESTED: image, wire and keyMap are inherited from MIRABOX_293_MODEL until measured. */
export const UPHERE_293V3_MODEL: DeviceModel = {
  id: 'uphere-293v3',
  vendor: 'uphere',
  protocol: 'mirabox-cora',
  name: 'upHere 293V3',
  usbVendorId: 0x1200,
  usbProductIds: [0x2012],
  usagePage: 0xffa0,
  usage: 1,
  keyCount: 15,
  columns: 5,
  rows: 3,
  keyWidth: 112,
  keyHeight: 112,
  image: { ...MIRABOX_293_MODEL.image },
  wire: { ...MIRABOX_293_MODEL.wire },
  keyMap: { ...MIRABOX_293_MODEL.keyMap },
  cora: {
    productId: ELGATO_MK2_PID,
    advertiseAs: 'mk2',
    usePhysicalIdentity: false,
  },
  splash: { transformOverride: { rotate: 180 } },
};
