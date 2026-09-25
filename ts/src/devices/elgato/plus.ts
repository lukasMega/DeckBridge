import type { DeviceModel } from '../driver.js';
import { ELGATO_PLUS_PID } from '../../types.js';

// Stream Deck + emulation profile. NOT in the USB probe list (DEVICE_MODELS) — it is
// resolved as a `cora.advertiseAs` target only. It holds the CORA facts (geometry,
// PID, firmware line); how a device paints the Plus grid on its own panel lives on
// that device's `cora.emulations` entry (e.g. ajazz/akp05e.ts).
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
  // A real Plus's own key format. Never driven over USB — an emulating device uses
  // its `cora.emulations['stream-deck-plus'].image` instead.
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
  // childFirmwareVersion is what the desktop validates against: a Plus reports a
  // 2.00.x line, and 1.01.x is rejected with "Device firmware is not supported.
  // Please update."
  cora: {
    productId: ELGATO_PLUS_PID,
    usePhysicalIdentity: false,
    childFirmwareVersion: '2.00.026',
  },
  driverKind: 'elgato-hid',
};
