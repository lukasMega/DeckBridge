import type { DeviceModel } from '../driver.js';
import { ELGATO_PLUS_PID, IMAGE_JPEG_QUALITY } from '../../types.js';

// Stream Deck + emulation profile. NOT in the USB probe list (DEVICE_MODELS) — it is
// resolved as a `cora.advertiseAs` target so another device (AJAZZ AKP05/AKP05E) can
// re-pair as a Plus. `cora.fullEmulation` makes a device that advertises AS this
// profile also adopt its `image` + `keyMap` (see devices/model-overrides.ts): the
// AKP05E panel is 112×112 and, unlike the MK.2 app, the Plus desktop sends key art
// upright (no 180° pre-rotation), so the physical transform is 180°. The keyMap maps
// the Plus 4×2 grid onto the AKP05E's left four columns, dropping the rightmost one.
export const STREAM_DECK_PLUS_MODEL: DeviceModel = {
  id: 'stream-deck-plus',
  vendor: 'elgato',
  protocol: 'elgato-gen2',
  name: 'Stream Deck +',
  usbVendorId: 0x0fd9,
  usbProductIds: [ELGATO_PLUS_PID],
  keyCount: 8,
  columns: 4,
  rows: 2,
  keyWidth: 120,
  keyHeight: 120,
  encoderCount: 4,
  touchWidth: 800,
  touchHeight: 100,
  // Physical transform for the emulating device (AKP05E): 112×112 keys, 180° rotation.
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
  wire: { packetSize: 1024, inSize: 512 },
  // Plus 4×2 onto the AKP05E's 5×2: left four columns only; the rightmost column
  // (wire image ids 15/10, input codes 5/10) is dropped.
  keyMap: {
    coraToWireImage: [11, 12, 13, 14, 6, 7, 8, 9],
    wireInputToCora: [-1, 0, 1, 2, 3, -1, 4, 5, 6, 7, -1],
  },
  // usePhysicalIdentity stays false — the AKP05E's own firmware (V3.AKP05E.02.007)
  // must NOT be forwarded to the desktop. childFirmwareVersion is what the desktop
  // validates against: a Plus reports a 2.00.x line, and 1.01.x is rejected with
  // "Device firmware is not supported. Please update."
  cora: {
    productId: ELGATO_PLUS_PID,
    usePhysicalIdentity: false,
    childFirmwareVersion: '2.00.026',
    fullEmulation: true,
  },
  driverKind: 'elgato-hid',
};
