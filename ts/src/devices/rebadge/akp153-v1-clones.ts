import type { DeviceModel, DeviceVendor } from '../driver.js';
import { MIRABOX_293S_MODEL } from '../mirabox/mirabox-293s.js';

/** The 7 v1 rebadges of the 293S board: `protocol_version 1`, 512-byte packets, 3×6
 *  physical grid (15 keys + a 3-key right column), JPEG 85×85, rotate90 + pad-to-85
 *  edge-clamp, mirror Both, keydown-only (no release event), identical 18-entry button
 *  remap. Confirmed by **both** keydeck (device JSON byte-identical to
 *  `Mirabox-HSV293S.json` apart from VID/PID and name) and opendeck-akp153
 *  (`Kind::protocol_version()` → 1, and `get_image_format_for_key()` derives the image
 *  spec from `protocol_version` alone — "same version" really is "same params").
 *
 *  NOT HARDWARE-TESTED. Every field below (including the derived `extraKeys` guess and
 *  the hardware-verified `keyMap`/`image` tuning) is inherited verbatim from
 *  `MIRABOX_293S_MODEL` by construction, so it cannot drift out of sync — see
 *  `mirabox-293s.ts` for the tuning rationale and its own hardware caveats.
 *
 *  Note `0x0300:0x1010` (AKP153E **rev. 1**, v1, here) vs the already-registered
 *  `0x0300:0x3010` (rev. 2, v3, `ajazz/akp153-rev2.ts`) — same VID, adjacent PIDs,
 *  completely different protocol. Likewise `0x0300:0x1020` (rev. 1) vs `0x0300:0x3011`
 *  (rev. 2). Don't merge them. */
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
  name: 'Ajazz AKP153E',
  vendor: 'ajazz',
  vid: 0x0300,
  pid: 0x1010,
});

export const AJAZZ_AKP153R_MODEL: DeviceModel = cloneOf293S({
  id: 'ajazz-akp153r',
  name: 'Ajazz AKP153R',
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
