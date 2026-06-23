import type { DeviceModel } from '../driver.js';
import { MINI_CHILD_GEOMETRY } from '../../capabilities.js';

// K1 Pro: 6 LCD keys (3×2) + 3 rotary encoders (encoders ignored for now —
// their input codes fall outside wireInputToCora and are dropped).
// Advertised to the Elgato app as a Stream Deck Mini. Report ID 0x04.
export const MIRABOX_K1PRO_MODEL: DeviceModel = {
  id: 'mirabox-k1pro',
  vendor: 'mirabox',
  protocol: 'mirabox-cora',
  name: 'Mirabox K1 Pro',
  usbVendorId: 0x6603,
  usbProductIds: [0x1015, 0x1019],
  usagePage: 0xffa0,
  usage: 1,
  keyCount: 6,
  columns: 3,
  rows: 2,
  keyWidth: 64,
  keyHeight: 64,
  image: {
    format: 'jpeg',
    width: 64,
    height: 64,
    // App sends Mini-oriented BMP; panel needs an extra 90° CW + horizontal flip,
    // which composes with the existing 90° CW to rotate 180° then flipH.
    rotate: 0,
    flipH: true,
    flipV: false,
    colorMode: 'rgb',
    // The Elgato app sends an 80×80 Mini BMP whose outer edge is dead border;
    // trim 6 px from every side (→ 68×68) before the 64×64 resize so the art
    // fills the key instead of sitting inside a margin.
    crop: 6,
    // The K1 Pro firmware drops the last byte of every full 1024-B image
    // chunk; wire.chunkPadByte compensates with a sacrificial pad byte per
    // chunk, which makes multi-chunk transfers fully reliable (probe round 16:
    // 2/3/5-chunk files clean at q90-q100). Remaining real constraints:
    // baseline, single interleaved scan (vendored rust/jpeg-encoder fork),
    // JPEG header through SOS within the first 1023 payload bytes (always true
    // for our ~370 B headers). 4096 caps the stepper well above any q90 64x64
    // encode (busiest dump: ~2.4 KB); hardware-verified clean up to 4484 B.
    // See .claude/plans/K1Pro/jpeg-artifact-findings.md.
    maxBytes: 4096,
    quality: 0.9,
    resizeFilter: 'lanczos3',
    transform: 'sidecar',
  },
  wire: {
    packetSize: 1024,
    inSize: 512,
    heartbeatMs: 2000,
    synthesizeKeyUp: false,
    sendStpAfterImage: true,
    reportId: 0x04,
    chunkPadByte: true,
  },
  keyMap: {
    coraToWireImage: [5, 3, 1, 6, 4, 2],
    wireInputToCora: [-1, 2, 5, 1, 4, 0, 3],
  },
  cora: {
    productId: 0x0063,
    advertiseGeometry: MINI_CHILD_GEOMETRY,
    usePhysicalIdentity: false,
  },
  // Splash sources are upright (not Mini-oriented), so they keep the original
  // rotate 90 / no flip — pin flipH explicitly so it doesn't inherit image.flipH.
  splash: { transformOverride: { rotate: 90, flipH: false } },
  driverKind: 'mirabox',
};
