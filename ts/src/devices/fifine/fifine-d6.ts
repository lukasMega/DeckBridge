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
    // Panel size is the least settled value here: the reference projects are split four
    // ways — 95 (jasonkoon/sd-connect, live-probed on a 0x0060), 100 (companion PR #49,
    // on a 0x0007), 105 (opendeck-ampgd6 main + FifineOpenSource), 112 (opendeck-ampgd6
    // PR #6 and PR #7, both on 0x0060). We take 112: it is the hardware-verified 293V3
    // size, and it is the only value two independent owners derived from the hardware
    // rather than inherited — PR #6 by tracing Fifine's own Windows software, PR #7 by
    // painting candidate resolutions onto separate keys ("At 105 the artwork leaves a
    // visible gap and each row smears against the fixed framebuffer stride").
    // 112 now also holds up on a real rev. 2 unit (macOS): keys render full-bleed.
    // Unlike packetSize below, this CANNOT be probed — the device never reports its
    // panel size and never complains. A wrong value shows as letterboxing, a gap, or a
    // soft image; re-measure on hardware before changing it.
    width: 112,
    height: 112,
    rotate: 0,
    flipH: false,
    flipV: false,
    colorMode: 'rgb',
    // Inherited from the 293V3, and deliberately LEFT ALONE even though a rev. 2 unit
    // proved the firmware takes far more: the `mise run d6-capture -- s3` ladder pushed
    // 7.9 / 10.8 / 14.0 / 22.7 / 22.9 KB onto five keys and every one rendered intact
    // (white frame closed on all four edges, right tally count, even noise fill). So this
    // is a headroom value, not a ceiling. Raising it buys nothing in practice — the
    // desktop's own 112×112 keys come through the sidecar at 1.9–4.8 KB (q 0.9), i.e.
    // less than half the cap, so it almost never binds — while each extra KB is one more
    // 1024-byte HID write per key on the worker thread. Only revisit it if a genuinely
    // detailed key is seen getting quality-crushed by the cap.
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

/** rev. 2 (PID `0x0060`): **1024-byte** packets — hardware-verified on macOS (panel
 *  renders, keys map correctly). 512-byte writes render BLACK on this
 *  revision — four independent 0x0060 owners hit it and all fixed it by moving to 1024
 *  (opendeck-ampgd6 PR #4, #5, #6, #7). PR #7 has the mechanism: the board reports
 *  `MaxOutputReportSize = 1024`, so every 513-byte write — brightness, clear, image
 *  chunks, the STP commit — is discarded by the firmware while `write()` still returns
 *  success; the device enumerates and reports button presses correctly and the screen
 *  simply stays black. That is exactly what `packetSizeCandidates` now probes for.
 *  (Lyagva's fork PR #1 is a *different* fix for the same symptom: it keeps
 *  `packetSize: 512` and instead enlarges the image chunks, serializes the writes and
 *  paces them 2 ms apart — see DeviceWireSpec.chunkDelayMs.)
 *  Do not "unify" the packet size with rev. 1. */
export const FIFINE_D6_REV2_MODEL: DeviceModel = {
  ...FIFINE_D6_BASE,
  id: 'fifine-d6-rev2',
  name: 'Fifine AmpliGame D6 (rev. 2)',
  usbProductIds: [0x0060],
  wire: { packetSize: 1024, ...D6_WIRE_COMMON },
};
