import type { DeviceModel } from '../driver.js';
import { ELGATO_MK2_PID } from '../../types.js';
import { MK2_CHILD_GEOMETRY } from '../../capabilities.js';

/** Ulanzi Stream Controller D200 — the first PAGE-protocol device in DeckBridge.
 *
 *  NOT HARDWARE-TESTED. Every constant here comes from the MIT-licensed
 *  reference implementations listed in docs/references.md ("Ulanzi devices");
 *  the AGPL-3.0 `glmagalhaes/rs-ulanzi-d200` is cited there for FACTS ONLY and
 *  was not used as an implementation reference. `.claude/plans/
 *  2026-09-10_ulanzi-d200-support.md` holds the per-constant attribution table
 *  and the Phase B bring-up runbook.
 *
 *  Why this is not just another `mirabox-cora` model: the firmware is a Linux
 *  appliance (Qt `UlanziDeckKey` on RK3308, or ZKSWE EasyUI on SSD210 — two
 *  generations behind ONE VID:PID) with no per-key image write at all. The host
 *  ships the whole grid as a ZIP (`manifest.json` + `Images/*.png`) over a
 *  `0x7c7c`-framed vendor channel and the firmware repaints from it. See
 *  devices/ulanzi/ulanzi-protocol.ts.
 *
 *  Physical layout — a 5×3 grid where only 13 cells are LCD keys:
 *
 *    ┌──────┬──────┬──────┬──────┬──────┐   slot id = row*5 + col
 *    │  0   │  1   │  2   │  3   │  4   │   manifest key = "{col}_{row}"
 *    ├──────┼──────┼──────┼──────┼──────┤
 *    │  5   │  6   │  7   │  8   │  9   │   13 real keys: ids 0..12
 *    ├──────┼──────┼──────┼──────┴──────┤   id 13 = wide info window ("3_2")
 *    │  10  │  11  │  12  │  13 (wide)  │   id 14 ("4_2") does not exist
 *    └──────┴──────┴──────┴─────────────┘
 *
 *  We still advertise a full MK.2 5×3/15 to the Elgato desktop and simply drop
 *  the two cells that have no key — the same trick the 293S uses in reverse.
 *
 *  Variants share this VID:PID and are NOT separate models (findModel() is
 *  VID+PID keyed): the D200H is protocol-identical and even reports
 *  `DeviceType:"D200"`; the D200X turns slot 13 into a real key and adds page
 *  buttons and encoders that need an extra unlock opcode we deliberately do not
 *  send. The driver logs the `0x0303` identity JSON on every open so a report
 *  from either can be told apart. */
export const ULANZI_D200_MODEL: DeviceModel = {
  id: 'ulanzi-d200',
  vendor: 'ulanzi',
  protocol: 'ulanzi-zk',
  name: 'Ulanzi Stream Controller D200',
  usbVendorId: 0x2207,
  usbProductIds: [0x0019],
  // Consumer page (0x0c) usage 0x01 — the vendor interface 0, NOT the boot
  // keyboard collection (0x01/0x06) the same device also exposes; writes to that
  // one time out. This is the least certain field on macOS, where nobody has
  // driven this device: 0x0c is also where the OS puts media keys, so if
  // hid_open_path never matches here, the fallback is an interface_number filter
  // in mirabox_hid_find_path (plan O3).
  usagePage: 0x0c,
  usage: 0x01,
  keyCount: 15, // grid cells; 13 are real keys — see the keyMap holes below
  columns: 5,
  rows: 3,
  keyWidth: 196,
  keyHeight: 196,
  image: {
    format: 'png',
    // Icons MUST be exactly 196×196: an undersized icon is rendered as a solid
    // square of its average colour rather than being scaled up.
    width: 196,
    height: 196,
    rotate: 0,
    flipH: false,
    flipV: false,
    colorMode: 'rgb',
    // ≈196 KB page cap / 13 icons, with headroom for the manifest and ZIP
    // headers. The cap is a real firmware limit on the Qt generation (larger
    // archives are dropped SILENTLY), so this is a budget the PNG encoder walks
    // a palette ladder to meet — not a hard error like the JPEG cap.
    maxBytes: 14336,
    quality: 1, // unused for PNG; kept for spec shape
    resizeFilter: 'lanczos3', // 72 → 196 is a 2.7× upscale
    sharpen: 0.6,
    transform: 'sidecar',
  },
  keyMap: {
    // CORA (MK.2, row-major) → device slot id. 13 = the wide info window and 14
    // is not a physical cell, so both are dropped by renderImage()'s -1 guard.
    coraToWireImage: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, -1, -1],
    // Device slot ids are identical to CORA indices for the 13 real keys; slot
    // 13 (the wide window, reported with category 0x00) maps to nothing.
    wireInputToCora: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, -1],
  },
  cora: {
    productId: ELGATO_MK2_PID,
    advertiseGeometry: MK2_CHILD_GEOMETRY, // 5×3/15 — the desktop draws 15, we light 13
    usePhysicalIdentity: false,
  },
  page: {
    packetSize: 1024,
    inSize: 1024,
    // Any outbound write resets the firmware watchdog; sources put the blanking
    // timeout at ~5–10 s, so 2 s satisfies the strictest of them.
    keepaliveMs: 2000,
    flushDebounceMs: 75,
    minFlushIntervalMs: 120,
    // Disputed: bitfocus and jcalado both ship the partial-update opcode and it
    // is what makes per-key CORA updates cheap (~15 writes instead of ~180),
    // but realhidden reports ghost/white keys from it and uses full pages only.
    // If keys render as white blocks on hardware, flip this to false first.
    partialUpdates: true,
    maxZipBytes: 196 * 1024,
    smallWindowMode: 203, // firmware digital clock, time only
    smallWindowSlot: { col: 3, row: 2 },
  },
  driverKind: 'ulanzi',
};
