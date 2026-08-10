import type { DeviceModel } from '../driver.js';
import { ELGATO_MK2_PID, IMAGE_JPEG_QUALITY } from '../../types.js';
import { MK2_CHILD_GEOMETRY } from '../../capabilities.js';

/** Ajazz AKP153E / AKP153R **rev. 2** — the same board as the Mirabox 293V3 behind a
 *  different VID/PID (`0x0300:0x3010` / `0x3011` instead of `0x6603:0x1005…`).
 *
 *  NOT HARDWARE-TESTED. Everything below is copied from MIRABOX_293_MODEL because the
 *  reference implementations describe the two as identical: protocol v3 (1024-byte CRT
 *  packets, press+release), 512-byte HID reads, usagePage 0xffa0/usage 1, 3×6 physical
 *  grid, JPEG keys, and the same button-remap table
 *  (opendeck-akp153 `src/mappings.rs` `protocol_version()`; keydeck
 *  `driver/devices/Ajazz-AKP153E-0x3010.json` is byte-identical to
 *  `Mirabox-HSV293SV3-0x1005.json` apart from VID/PID and human name).
 *  `keyMap` in particular was verified on 293V3 hardware only — if keys light up in the
 *  wrong place on a real AKP153 rev. 2, that table is the first thing to re-derive.
 *
 *  Rev. 1 (`0x0300:0x1010` / `0x1020`) is a v1/512-byte device and is deliberately NOT
 *  covered here — it needs the 293S-style model instead. */
const AKP153_REV2_BASE: Omit<DeviceModel, 'id' | 'name' | 'usbProductIds'> = {
  vendor: 'ajazz',
  protocol: 'mirabox-cora',
  usbVendorId: 0x0300,
  usagePage: 0xffa0,
  usage: 1,
  keyCount: 15,
  columns: 5,
  rows: 3,
  keyWidth: 112,
  keyHeight: 112,
  image: {
    format: 'jpeg',
    width: 112,
    height: 112,
    rotate: 0,
    flipH: false,
    flipV: false,
    colorMode: 'rgb',
    maxBytes: 10240,
    quality: IMAGE_JPEG_QUALITY,
    resizeFilter: 'lanczos3',
    sharpen: 0.6,
    transform: 'sidecar',
  },
  wire: {
    packetSize: 1024,
    inSize: 512,
    heartbeatMs: 8000,
    synthesizeKeyUp: false,
    sendStpAfterImage: true,
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

export const AJAZZ_AKP153E_REV2_MODEL: DeviceModel = {
  ...AKP153_REV2_BASE,
  id: 'ajazz-akp153e-rev2',
  name: 'Ajazz AKP153E (rev. 2)',
  usbProductIds: [0x3010],
};

export const AJAZZ_AKP153R_REV2_MODEL: DeviceModel = {
  ...AKP153_REV2_BASE,
  id: 'ajazz-akp153r-rev2',
  name: 'Ajazz AKP153R (rev. 2)',
  usbProductIds: [0x3011],
};
