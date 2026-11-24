import type { DeviceModel } from '../driver.js';
import { MIRABOX_293_MODEL } from './mirabox-293.js';

/** Mirabox Stream Dock 293, first generation (5×3). hardware-tested on Windows (#292) — sources and
 *  per-field basis in ../PROVENANCE.md. Do not merge with 0x6602:0x1001 (N4) or
 *  0x0b00:0x1001 (MSD-TWO): same PID, other VIDs and protocols. */
export const MIRABOX_293_GEN1_MODEL: DeviceModel = {
  ...MIRABOX_293_MODEL,
  id: 'mirabox-293-gen1',
  name: 'Mirabox 293 (gen 1)',
  usbVendorId: 0x5500,
  usbProductIds: [0x1001],
  // 100 px: SDK, rigor789 and kebot agree; rotation stays V3's hardware-verified 0.
  keyWidth: 100,
  keyHeight: 100,
  // unverified: maxBytes carried over from V3.
  image: { ...MIRABOX_293_MODEL.image, width: 100, height: 100, maxBytes: 10240 },
  wire: {
    // SDK reports 513 = id + 512; candidates let the report descriptor correct a wrong guess.
    packetSize: 512,
    packetSizeCandidates: [512, 1024],
    inSize: 512,
    // unverified: family default, gen1 may not need the keepalive.
    heartbeatMs: 8000,
    // unverified on hardware: SDK and rigor789 both report release as state 0x00.
    synthesizeKeyUp: false,
    sendStpAfterImage: true,
    // The deck reports iSerial 0, so two decks would otherwise collide on one device key.
    sharedSerial: true,
  },
};
