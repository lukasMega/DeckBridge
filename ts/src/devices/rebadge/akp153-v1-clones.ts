import type { DeviceModel, DeviceVendor } from '../driver.js';
import { MIRABOX_293S_MODEL } from '../mirabox/mirabox-293s.js';

/** `[id, name, vendor, usbVendorId, usbProductId]` — the only fields a rebadge changes. */
type CloneSpec = readonly [string, string, DeviceVendor, number, number];

/** Behavior flags every v1 rebadge pins on purpose, so a later 293S edit (say, enabling
 *  batching or a new heartbeat) never reaches an unverified clone silently. Values equal
 *  today's 293S ones. `chunkDelayMs` stays unset: the 293S sets none and no clone needs it. */
const V1_CLONE_BEHAVIOR = {
  heartbeatMs: 8000,
  synthesizeKeyUp: true,
  batchImageTransfers: false,
} as const;

function cloneOf293S([id, name, vendor, vid, pid]: CloneSpec): DeviceModel {
  return {
    ...MIRABOX_293S_MODEL,
    id,
    name,
    vendor,
    usbVendorId: vid,
    usbProductIds: [pid],
    wire: { ...MIRABOX_293S_MODEL.wire, ...V1_CLONE_BEHAVIOR },
  };
}

const V1_CLONE_SPECS: readonly CloneSpec[] = [
  ['ajazz-akp153', 'Ajazz AKP153', 'ajazz', 0x5548, 0x6674],
  // '(rev. 1)' is part of the name: the rev. 2 board (ajazz/akp153-rev2.ts) ships under
  // the same product name on a different protocol, and the two sit next to each other in
  // the UI, the device docs and the logs.
  ['ajazz-akp153e', 'Ajazz AKP153E (rev. 1)', 'ajazz', 0x0300, 0x1010],
  ['ajazz-akp153r', 'Ajazz AKP153R (rev. 1)', 'ajazz', 0x0300, 0x1020],
  ['mars-msd-one', 'Mars Gaming MSD-ONE', 'mars-gaming', 0x0b00, 0x1000],
  ['maddog-gk150k', 'Mad Dog GK150K', 'mad-dog', 0x0c00, 0x1000],
  ['risemode-vision-01', 'Risemode Vision 01', 'risemode', 0x0a00, 0x1001],
  ['tmice-stream-controller', 'TMICE Stream Controller', 'tmice', 0x0500, 0x1001],
];

/** The 7 v1 rebadges of the 293S board: `protocol_version 1`, 512-byte packets, 3×6
 *  physical grid, keydown-only. NOT HARDWARE-TESTED — geometry, image and packet fields are
 *  inherited from MIRABOX_293S_MODEL; the wire behavior flags are pinned by
 *  V1_CLONE_BEHAVIOR and do NOT follow 293S edits. Beware the adjacent-PID trap against
 *  ajazz/akp153-rev2.ts; the table is in ../PROVENANCE.md. */
export const AKP153_V1_CLONE_MODELS: readonly DeviceModel[] = V1_CLONE_SPECS.map(cloneOf293S);
