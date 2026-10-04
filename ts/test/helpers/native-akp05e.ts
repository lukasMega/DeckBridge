import { AJAZZ_AKP05E_MODEL } from '../../src/devices/ajazz/akp05e.js';
import type { DeviceModel } from '../../src/devices/driver.js';
import { ELGATO_MK2_PID } from '../../src/shared/types.js';

/** AKP05E paired natively (geometry-only 5×2, no Plus emulation): the code path no
 *  registry model defaults to any more, kept covered here. */
export const NATIVE_AKP05E_MODEL: DeviceModel = {
  ...AJAZZ_AKP05E_MODEL,
  image: { ...AJAZZ_AKP05E_MODEL.image, rotate: 0 },
  keyMap: {
    coraToWireImage: [11, 12, 13, 14, 15, 6, 7, 8, 9, 10],
    wireInputToCora: [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  },
  cora: { productId: ELGATO_MK2_PID, usePhysicalIdentity: false },
};
