import type { DeviceModel } from '../driver.js';

export const MK2_MODEL: DeviceModel = {
  id: 'mk2',
  vendor: 'elgato',
  protocol: 'elgato-gen2',
  name: 'Stream Deck MK.2',
  usbVendorId: 0x0fd9,
  usbProductIds: [0x0080, 0x006d, 0x00a5],
  keyCount: 15,
  columns: 5,
  rows: 3,
  keyWidth: 72,
  keyHeight: 72,
  image: {
    format: 'jpeg',
    width: 72,
    height: 72,
    // Phase 0: if CORA images are upright set rotate:180; if MK.2-native set rotate:0.
    // Passthrough (0) until hardware measurement confirms.
    rotate: 0,
    flipH: false,
    flipV: false,
    colorMode: 'rgb',
    maxBytes: 0,
    quality: 0.95,
    transform: 'passthrough',
  },
  keyMap: {},
  // Preserves today's behavior: coraProductId() falls back to usbProductIds[0] for Elgato.
  cora: { productId: 0x0080, usePhysicalIdentity: true },
  driverKind: 'elgato-hid',
};
