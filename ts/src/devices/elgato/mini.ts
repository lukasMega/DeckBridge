import type { DeviceModel } from '../driver.js';

// Mini key size: 80×80. BMP payload: 54 + 80*80*3 = 19254 bytes → 20 packets.
// Pixel transform { colorMode:'bgr', rotate:90° CW } matches reference 6-key.ts:39
// { colorMode:'bgr', rotate:true, yFlip:true } which equals 90° CW.
// Assumes CORA images are upright (Phase 0 to confirm).
export const MINI_MODEL: DeviceModel = {
  id: 'mini',
  vendor: 'elgato',
  protocol: 'elgato-gen1',
  name: 'Stream Deck Mini',
  usbVendorId: 0x0fd9,
  usbProductIds: [0x0063, 0x0090, 0x00b3, 0x00b8],
  keyCount: 6,
  columns: 3,
  rows: 2,
  keyWidth: 80,
  keyHeight: 80,
  image: {
    format: 'bmp',
    width: 80,
    height: 80,
    rotate: 90,
    flipH: false,
    flipV: false,
    colorMode: 'bgr',
    bmpPpm: 2835,
    maxBytes: 0,
    quality: 0,
    // BMP is forwarded as-is (image-pipeline's format==='bmp' short-circuit runs first);
    // 'passthrough' here is for consistency, per the plan's §4.A note.
    transform: 'passthrough',
  },
  keyMap: {},
  // Preserves today's behavior: coraProductId() falls back to usbProductIds[0] for Elgato.
  cora: { productId: 0x0063, usePhysicalIdentity: true },
  splash: { transformOverride: { rotate: 90, flipH: true } },
  driverKind: 'elgato-hid',
};
