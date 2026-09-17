import type { DeviceModel, DeviceVendor } from '../driver.js';
import { MIRABOX_293S_MODEL } from '../mirabox/mirabox-293s.js';

/** The 7 v1 rebadges of the 293S board: `protocol_version 1`, 512-byte packets, 3×6
 *  physical grid, keydown-only. NOT HARDWARE-TESTED — hardware fields are inherited verbatim
 *  from MIRABOX_293S_MODEL by construction, so it cannot drift. Beware the adjacent-PID
 *  trap against ajazz/akp153-rev2.ts; the table is in ../PROVENANCE.md. */
function cloneOf293S(o: {
  id: string;
  name: string;
  vendor: DeviceVendor;
  vid: number;
  pid: number;
}): DeviceModel {
  return {
    ...MIRABOX_293S_MODEL,
    id: o.id,
    name: o.name,
    vendor: o.vendor,
    usbVendorId: o.vid,
    usbProductIds: [o.pid],
    // Only the original 293S has hardware-tested batching; rebadges opt in.
    wire: { ...MIRABOX_293S_MODEL.wire!, batchImageTransfers: false },
  };
}

export const AJAZZ_AKP153_MODEL: DeviceModel = cloneOf293S({
  id: 'ajazz-akp153',
  name: 'Ajazz AKP153',
  vendor: 'ajazz',
  vid: 0x5548,
  pid: 0x6674,
});

export const AJAZZ_AKP153E_MODEL: DeviceModel = cloneOf293S({
  id: 'ajazz-akp153e',
  // '(rev. 1)' is part of the name: the rev. 2 board (ajazz/akp153-rev2.ts) ships under
  // the same product name on a different protocol, and the two sit next to each other in
  // the UI, the device docs and the logs.
  name: 'Ajazz AKP153E (rev. 1)',
  vendor: 'ajazz',
  vid: 0x0300,
  pid: 0x1010,
});

export const AJAZZ_AKP153R_MODEL: DeviceModel = cloneOf293S({
  id: 'ajazz-akp153r',
  name: 'Ajazz AKP153R (rev. 1)',
  vendor: 'ajazz',
  vid: 0x0300,
  pid: 0x1020,
});

export const MARS_MSD_ONE_MODEL: DeviceModel = cloneOf293S({
  id: 'mars-msd-one',
  name: 'Mars Gaming MSD-ONE',
  vendor: 'mars-gaming',
  vid: 0x0b00,
  pid: 0x1000,
});

export const MADDOG_GK150K_MODEL: DeviceModel = cloneOf293S({
  id: 'maddog-gk150k',
  name: 'Mad Dog GK150K',
  vendor: 'mad-dog',
  vid: 0x0c00,
  pid: 0x1000,
});

export const RISEMODE_VISION_01_MODEL: DeviceModel = cloneOf293S({
  id: 'risemode-vision-01',
  name: 'Risemode Vision 01',
  vendor: 'risemode',
  vid: 0x0a00,
  pid: 0x1001,
});

export const TMICE_STREAM_CONTROLLER_MODEL: DeviceModel = cloneOf293S({
  id: 'tmice-stream-controller',
  name: 'TMICE Stream Controller',
  vendor: 'tmice',
  vid: 0x0500,
  pid: 0x1001,
});
