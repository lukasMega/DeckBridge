import { ELGATO_MK2_PID, IMAGE_JPEG_QUALITY } from '../../types.js';
import type { DeviceEmulation, DeviceImageSpec, DeviceModel } from '../driver.js';

const KEY_IMAGE: DeviceImageSpec = {
  format: 'jpeg',
  width: 112,
  height: 112,
  rotate: 0,
  flipH: false,
  flipV: false,
  colorMode: 'rgb',
  maxBytes: 0xffff,
  quality: IMAGE_JPEG_QUALITY,
  resizeFilter: 'lanczos3',
  sharpen: 0.6,
  transform: 'sidecar',
};

const TOUCH_STRIP_IMAGE: DeviceImageSpec = { ...KEY_IMAGE, width: 128, height: 128, rotate: 180 };

// Re-paired as a Stream Deck +: unlike the MK.2 app, the Plus desktop sends key art
// upright (no 180° pre-rotation), so the physical transform is 180°. The Plus 4×2 grid
// maps onto the left four columns; the rightmost (wire image ids 15/10, input codes
// 5/10) is dropped. usePhysicalIdentity stays false — the AKP05E's own firmware
// (V3.AKP05E.02.007) must not reach the desktop.
const STREAM_DECK_PLUS_EMULATION: DeviceEmulation = {
  image: { ...KEY_IMAGE, rotate: 180 },
  keyMap: {
    coraToWireImage: [11, 12, 13, 14, 6, 7, 8, 9],
    wireInputToCora: [-1, 0, 1, 2, 3, -1, 4, 5, 6, 7, -1],
  },
};

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
  image: KEY_IMAGE,
  splash: { transformOverride: { rotate: 180 } },
  wire: { packetSize: 1024, inSize: 512, reportId: 0 },
  widgetDisplays: [
    { wireId: 1, label: 'Left', image: TOUCH_STRIP_IMAGE },
    { wireId: 2, label: 'Left center', image: TOUCH_STRIP_IMAGE },
    { wireId: 3, label: 'Right center', image: TOUCH_STRIP_IMAGE },
    { wireId: 4, label: 'Right', image: TOUCH_STRIP_IMAGE },
  ],
  // Input codes are 1-based and row-ordered (1-5 top, 6-10 bottom), unlike the image
  // wire ids above. Encoder/touch codes (0x33+) are decoded by the driver, not mapped here.
  keyMap: {
    coraToWireImage: [11, 12, 13, 14, 15, 6, 7, 8, 9, 10],
    wireInputToCora: [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  },
  // Desktop acceptance of custom 2x5 geometry needs hardware pairing validation.
  cora: {
    productId: ELGATO_MK2_PID,
    usePhysicalIdentity: false,
    emulations: { 'stream-deck-plus': STREAM_DECK_PLUS_EMULATION },
  },
  driverKind: 'custom',
};
