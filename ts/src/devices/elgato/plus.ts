import type { DeviceModel } from '../driver.js';
import {
  ELGATO_PLUS_PID,
  CHILD_CAPS_PLUS_LAYOUT_TYPE,
} from '../../types.js';

// Stream Deck + emulation profile. NOT in the USB probe list (DEVICE_MODELS) — it is
// resolved as a `cora.advertiseAs` target so another device (AJAZZ AKP05/AKP05E) can
// re-pair as a Plus. Its geometry + productId drive the advertised capabilities; the
// image/wire/keyMap/driverKind fields are profile metadata only (a real Plus is not
// opened through this entry). Encoder/touch dims come from the plan's CORA data —
// the layout-type byte and touch-dim capabilities offsets remain UNVERIFIED.
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
  layoutType: CHILD_CAPS_PLUS_LAYOUT_TYPE,
  image: {
    format: 'jpeg',
    width: 120,
    height: 120,
    rotate: 0,
    flipH: false,
    flipV: false,
    colorMode: 'rgb',
    maxBytes: 0,
    quality: 0.95,
    transform: 'passthrough',
  },
  wire: { packetSize: 1024, inSize: 512 },
  keyMap: {},
  cora: { productId: ELGATO_PLUS_PID, usePhysicalIdentity: true },
  driverKind: 'elgato-hid',
};
