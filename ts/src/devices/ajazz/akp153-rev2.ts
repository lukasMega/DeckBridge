import type { DeviceModel } from '../driver.js';
import { ELGATO_MK2_PID, IMAGE_JPEG_QUALITY } from '../../types.js';
import { MK2_CHILD_GEOMETRY } from '../../capabilities.js';

/** Ajazz AKP153E / AKP153R **rev. 2** — the Mirabox 293V3 protocol behind a different
 *  VID/PID (`0x0300:0x3010` / `0x3011`). Shared defaults come from MIRABOX_293_MODEL;
 *  AKP153E hardware-calibrated geometry and mapping override them below. AKP153R remains
 *  untested. Rev. 1 (`0x1010`/`0x1020`) uses v1; see rebadge/akp153-v1-clones.ts. */
const AKP153_REV2_BASE: Omit<DeviceModel, 'id' | 'name' | 'usbProductIds'> = {
  vendor: 'ajazz',
  protocol: 'mirabox-cora',
  usbVendorId: 0x0300,
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
