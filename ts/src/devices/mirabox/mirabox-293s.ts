import type { DeviceModel } from '../driver.js';
import { ELGATO_MK2_PID } from '../../types.js';
import { MK2_CHILD_GEOMETRY } from '../../capabilities.js';

export const MIRABOX_293S_MODEL: DeviceModel = {
  id: 'mirabox-293s',
  vendor: 'mirabox',
  protocol: 'mirabox-cora-v1',
  name: 'Mirabox 293S Stream Deck',
  usbVendorId: 0x5548,
  usbProductIds: [0x6670],
  usagePage: 0xffa0,
  usage: 1,
  // Hardware is 3×6 = 18 keys; we emulate a 15-key MK.2 using the left 5 columns.
  keyCount: 15,
  columns: 5,
  rows: 3,
  keyWidth: 85,
  keyHeight: 85,
  image: {
    format: 'jpeg',
    width: 85,
    height: 85,
    // Verified on Mirabox 293S hardware: net transform must be the anti-transpose
    // (rotate90 ∘ flipV). The opendeck-akp153 v1 guess (rotate90 + flipH + flipV)
    // reduces to a pure rotate270 and rendered images vertically flipped.
    rotate: 90,
    flipH: false,
    flipV: false,
    colorMode: 'rgb',
    maxBytes: 5120,
    quality: 0.7,
    // App sends MK.2-native 72×72; panel is 85×85. Keep pixels 1:1 (no upscale blur)
    // and edge-clamp the 13px border. Centred 6/7 (top-left bias) in the source frame.
    resizeMode: 'pad',
    padFill: 'edge',
    sharpen: 0, // moot without upscale
    transform: 'sidecar',
  },
  wire: {
    packetSize: 512,
    inSize: 512,
    heartbeatMs: 8000,
    synthesizeKeyUp: true,
    sendStpAfterImage: false,
  },
  keyMap: {
    // 293S is physically 3×6 = 18 keys; we expose the left 5 columns as a 15-key MK.2.
    // mk2 index (0..14) → device wire key id (1-based, BAT/CLE). VERIFIED ON HARDWARE.
    coraToWireImage: [13, 10, 7, 4, 1, 14, 11, 8, 5, 2, 15, 12, 9, 6, 3],
    // device input wire code (1-based) → mk2 index; -1 = unused 6th column. Index 0 unused.
    wireInputToCora: [-1, 4, 9, 14, 3, 8, 13, 2, 7, 12, 1, 6, 11, 0, 5, 10, -1, -1, -1],
    // 6th column, top→bottom. Derived from the opendeck-akp153 wire-id namespace
    // (left 15 hardware-verified; 16–18 derived — verify: press the right column
    // in a debug build and look for ACK key=0x10/0x11/0x12 in the comm log).
    extraKeys: [16, 17, 18],
  },
  cora: {
    productId: ELGATO_MK2_PID,
    // Advertise as a Stream Deck MK.2 (72×72). The Elgato app keys image resolution
    // off the PID profile, not the advertised keyWidth/keyHeight: a 2026-06-15 test
    // advertising 85×85 here still made the app send 72×72. See findings doc
    // "mirabox-293s-slow-image-render.md".
    advertiseGeometry: MK2_CHILD_GEOMETRY,
    usePhysicalIdentity: false,
  },
  splash: { transformOverride: { rotate: 270 } },
  driverKind: 'mirabox',
};
