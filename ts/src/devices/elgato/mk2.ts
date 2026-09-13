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
    // CORA images arrive MK.2-native (already 180°-rotated by the desktop app).
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
  // Splash/extra-key sources are upright, so they need the 180° the CORA path
  // already has baked in.
  splash: { transformOverride: { rotate: 180 } },
  driverKind: 'elgato-hid',
};
