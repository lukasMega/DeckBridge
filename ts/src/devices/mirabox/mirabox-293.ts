import type { DeviceModel } from '../driver.js';
import { ELGATO_MK2_PID, IMAGE_JPEG_QUALITY } from '../../types.js';
import { MK2_CHILD_GEOMETRY } from '../../capabilities.js';

export const MIRABOX_293_MODEL: DeviceModel = {
  id: 'mirabox-293',
  vendor: 'mirabox',
  protocol: 'mirabox-cora',
  name: 'Mirabox 293V3/Ajazz',
  usbVendorId: 0x6603,
  usbProductIds: [0x1005, 0x1006, 0x1010],
  usagePage: 0xffa0,
  usage: 1,
  keyCount: 15,
  columns: 5,
  rows: 3,
  keyWidth: 112,
  keyHeight: 112,
  image: {
    format: 'jpeg',
    width: 112,
    height: 112,
    rotate: 0,
    flipH: false,
    flipV: false,
    colorMode: 'rgb',
    maxBytes: 10240,
    quality: IMAGE_JPEG_QUALITY,
    resizeFilter: 'lanczos3',
    sharpen: 0.6,
    transform: 'sidecar',
  },
  wire: {
    packetSize: 1024,
    inSize: 512,
    heartbeatMs: 8000,
    synthesizeKeyUp: false,
    sendStpAfterImage: true,
  },
  keyMap: {
    // mk2 index (0..14, row-major) → device wire image id (1-based).
    coraToWireImage: [11, 12, 13, 14, 15, 6, 7, 8, 9, 10, 1, 2, 3, 4, 5],
    // device input wire code is mk2 index + 1.
    inputOffset: 1,
  },
  cora: {
    productId: ELGATO_MK2_PID,
    advertiseGeometry: MK2_CHILD_GEOMETRY,
    usePhysicalIdentity: false,
  },
  splash: { transformOverride: { rotate: 180 } },
  driverKind: 'mirabox',
};
