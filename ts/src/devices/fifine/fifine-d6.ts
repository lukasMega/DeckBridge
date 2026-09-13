import type { DeviceModel } from '../driver.js';
import { ELGATO_MK2_PID, IMAGE_JPEG_QUALITY } from '../../types.js';
import { MK2_CHILD_GEOMETRY } from '../../capabilities.js';

/** Fifine AmpliGame D6 — the Mirabox 293V3 board behind VID `0x3142`. Two models, not
 *  two PIDs on one: rev. 1 (`0x0007`) writes 512-byte packets, rev. 2 (`0x0060`) 1024.
 *  Rev. 2 is hardware-tested and its checked-in report descriptor supplies packetSize /
 *  inSize; rev. 1 is untested. Provenance + open questions: ../PROVENANCE.md. */
const FIFINE_D6_BASE: Omit<DeviceModel, 'id' | 'name' | 'usbProductIds' | 'wire'> = {
  vendor: 'fifine',
  protocol: 'mirabox-cora',
  usbVendorId: 0x3142,
  usagePage: 0xffa0,
  usage: 1,
  keyCount: 15,
  columns: 5,
  rows: 3,
  keyWidth: 112,
  keyHeight: 112,
  image: {
    format: 'jpeg',
    // Least settled value on this device — upstream splits four ways (95/100/105/112).
    // CANNOT be probed: the panel is never reported and a wrong value never errors, it
    // just letterboxes or smears. Re-measure on hardware before changing; see
    // ../PROVENANCE.md.
    width: 112,
    height: 112,
    rotate: 0,
    flipH: false,
    flipV: false,
    colorMode: 'rgb',
    // Headroom, not a ceiling: hardware takes >22 KB, but real keys arrive at 1.9-4.8 KB
    // so the cap almost never binds, and each extra KB is another HID write on the worker
    // thread. Ladder results in ../PROVENANCE.md.
    maxBytes: 10240,
    quality: IMAGE_JPEG_QUALITY,
    resizeFilter: 'lanczos3',
    sharpen: 0.6,
    transform: 'sidecar',
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

/** Wire fields shared by both revisions — only `packetSize` differs. */
const D6_WIRE_COMMON = {
  inSize: 512,
  heartbeatMs: 8000,
  // Both revisions report press AND release, so nothing is synthesized.
  // rev. 1 (assumed): upstream forces its event reader to protocol 3 (see the header
  // note). rev. 2: confirmed on hardware — down and up events both arrive.
  // Not runtime-detectable: a key that never reports "up" is indistinguishable from a
  // key the user is still holding, so there is no safe automatic fallback. If rev. 1
  // turns out to be keydown-only the symptom is a stuck key, and the fix is
  // `synthesizeKeyUp: true` on that model alone.
  synthesizeKeyUp: false,
  sendStpAfterImage: true,
  // Packet size IS runtime-detectable, and getting it wrong is invisible (silent
  // discarded writes → black panel), so let the report descriptor arbitrate between the
  // two sizes this family is known to use. Applies to both revisions on purpose: rev. 1's
  // 512 is inferred too, and its own source called it surprising ("Not sure why, but it
  // works with it" — companion PR #49). See DeviceWireSpec.packetSizeCandidates.
  packetSizeCandidates: [512, 1024],
} as const;

/** rev. 1 (PID `0x0007`): **512-byte** CRT packets, the one value the companion PR #49
 *  author explicitly called out as surprising ("Not sure why, but it works with it"),
 *  corroborated by opendeck-ampgd6 and FifineOpenSource both writing at mirajazz
 *  protocol_version 1. `packetSizeCandidates` lets the device overrule this if the
 *  report descriptor disagrees. */
export const FIFINE_D6_MODEL: DeviceModel = {
  ...FIFINE_D6_BASE,
  id: 'fifine-d6',
  name: 'Fifine AmpliGame D6',
  usbProductIds: [0x0007],
  wire: { packetSize: 512, ...D6_WIRE_COMMON },
};

/** rev. 2 (PID `0x0060`): **1024-byte** packets — hardware-verified on macOS. A 513-byte
 *  write is silently discarded by this firmware (`MaxOutputReportSize = 1024`) while
 *  `write()` still returns success, so the panel just stays black; that is what
 *  `packetSizeCandidates` probes for. Do not "unify" with rev. 1 — see ../PROVENANCE.md. */
export const FIFINE_D6_REV2_MODEL: DeviceModel = {
  ...FIFINE_D6_BASE,
  id: 'fifine-d6-rev2',
  name: 'Fifine AmpliGame D6 (rev. 2)',
  usbProductIds: [0x0060],
  wire: { packetSize: 1024, ...D6_WIRE_COMMON },
};
