import { ELGATO_MK2_PID, IMAGE_JPEG_QUALITY } from '../../types.js';
import type { DeviceModel } from '../driver.js';

/** AJAZZ AKP05E. Only PID 0x3004 has output-protocol evidence. */
export const AJAZZ_AKP05E_MODEL: DeviceModel = {
  id: 'ajazz-akp05e',
  vendor: 'ajazz',
  protocol: 'ajazz-akp05',
  name: 'AJAZZ AKP05E',
  usbVendorId: 0x0300,
  usbProductIds: [0x3004],
  usagePage: 0xffa0,
  usage: 1,
  keyCount: 10,
  columns: 5,
  rows: 2,
  keyWidth: 112,
  keyHeight: 112,
  image: {
    format: 'jpeg',
    width: 112,
    height: 112,
    rotate: 180,
    flipH: false,
    flipV: false,
    colorMode: 'rgb',
    maxBytes: 0xffff,
    quality: IMAGE_JPEG_QUALITY,
    resizeFilter: 'lanczos3',
    sharpen: 0.6,
    transform: 'sidecar',
  },
  wire: { packetSize: 1024, inSize: 512, reportId: 0 },
  keyMap: { coraToWireImage: [11, 12, 13, 14, 15, 6, 7, 8, 9, 10] },
  // Desktop acceptance of custom 2x5 geometry needs hardware pairing validation.
  cora: { productId: ELGATO_MK2_PID, usePhysicalIdentity: false },
  driverKind: 'custom',
};
