import type { DeviceModel } from '../driver.js';
import { MIRABOX_293_MODEL } from '../mirabox/mirabox-293.js';

/** Fifine AmpliGame D6 — the Mirabox 293V3 board behind VID `0x3142`. Two models, not two PIDs
 * on one: rev. 1 (`0x0007`) writes 512-byte packets, rev. 2 (`0x0060`) 1024. Rev. 2 is
 * hardware-tested and its checked-in report descriptor supplies packetSize / inSize; rev. 1 is untested. */
const FIFINE_D6_BASE = {
  ...MIRABOX_293_MODEL,
  vendor: 'fifine',
  usbVendorId: 0x3142,
} satisfies DeviceModel;

/** Wire fields shared by both revisions — only `packetSize` differs. */
const D6_WIRE_COMMON = {
  inSize: 512,
  heartbeatMs: 8000,
  // Both revisions report press AND release, so nothing is synthesized. rev.
  // 1 (assumed): upstream forces its event reader to protocol 3 (see the
  // header note). rev. 2: confirmed on hardware — down and up events both arrive.
  synthesizeKeyUp: false,
  sendStpAfterImage: true,
  // Packet size IS runtime-detectable, and getting it wrong is invisible (silent
  // discarded writes → black panel), so let the report descriptor arbitrate between the
  // two sizes this family is known to use. Applies to both revisions on purpose: rev.
  packetSizeCandidates: [512, 1024],
} as const;

/** rev. 1 (PID `0x0007`): **512-byte** CRT packets, the one value the companion PR #49
 * author explicitly called out as surprising ("Not sure why, but it works with it"),
 * corroborated by opendeck-ampgd6 and FifineOpenSource both writing at mirajazz protocol_version 1. */
export const FIFINE_D6_MODEL: DeviceModel = {
  ...FIFINE_D6_BASE,
  id: 'fifine-d6',
  name: 'Fifine AmpliGame D6',
  usbProductIds: [0x0007],
  wire: { packetSize: 512, ...D6_WIRE_COMMON },
};

/** rev. 2 (PID `0x0060`): **1024-byte** packets — hardware-verified on macOS. A 513-byte write
 * is silently discarded by this firmware (`MaxOutputReportSize = 1024`) while `write()` still
 * returns success, so the panel just stays black; that is what `packetSizeCandidates` probes for. */
export const FIFINE_D6_REV2_MODEL: DeviceModel = {
  ...FIFINE_D6_BASE,
  id: 'fifine-d6-rev2',
  name: 'Fifine AmpliGame D6 (rev. 2)',
  usbProductIds: [0x0060],
  wire: { packetSize: 1024, ...D6_WIRE_COMMON },
};
