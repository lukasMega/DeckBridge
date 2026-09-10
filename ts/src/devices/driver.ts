import type { EventEmitter } from 'node:events';
import type { ImageModeOverride } from '../types.js';

export type DeviceVendor =
  | 'mirabox'
  | 'ajazz'
  | 'elgato'
  | 'mars-gaming'
  | 'mad-dog'
  | 'risemode'
  | 'tmice'
  | 'fifine'
  | 'ulanzi';

/** Wire protocol — closed; adding a new model almost always reuses an existing one. */
export type DeviceProtocol =
  | 'mirabox-cora' // v3, 1024-byte packets, press+release
  | 'mirabox-cora-v1' // v1, 512-byte packets, keydown-only
  | 'elgato-gen1' // BMP, 16-byte header, key+1, feature 0x05/0x0B (Mini, original)
  | 'elgato-gen2' // JPEG, 8-byte header, feature 0x03 (MK.2, XL)
  // PAGE protocol, not a per-key one: the host ships the WHOLE grid as a ZIP
  // (manifest.json + Images/*.png) inside a 0x7c7c-framed vendor report and the
  // firmware repaints from it. There is no "write one key" opcode; per-key CORA
  // updates are emulated by rebuilding and resending a (partial) page.
  // See devices/ulanzi/ulanzi-protocol.ts.
  | 'ulanzi-zk';

/** Stable kebab-case slug used as cache key, UI label, logs. */
// eslint-disable-next-line sonarjs/redundant-type-aliases
export type DeviceModelId = string;

/** Native image format the DEVICE consumes (not what CORA sends us — that stays
 *  'jpeg' | 'bmp', see types.ts ImageEvent). 'png' exists for page-protocol
 *  devices whose firmware unzips PNGs out of a manifest (Ulanzi D200). */
export type DeviceImageFormat = 'jpeg' | 'bmp' | 'png';

export interface DeviceImageSpec {
  format: DeviceImageFormat;
  width: number;
  height: number;
  /** Extra CW rotation applied on top of the CORA JPEG before sending to hardware.
   *  Phase 0 measurement determines the correct value:
   *  - If CORA images are upright: MK.2 needs 180, Mini needs 90.
   *  - If CORA images are MK.2-native (already 180°): MK.2 needs 0, Mini needs 270.
   *  Default assumes CORA images are upright. */
  rotate: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
  colorMode: 'rgb' | 'bgr';
  bmpPpm?: number; // 2835 for Mini
  maxBytes: number; // JPEG size cap; 0 = no cap (BMP is fixed-size)
  quality: number; // JPEG only (0–1)
  blur?: number; // Gaussian blur sigma before JPEG encode (0 = none)
  /** Unsharp-mask sigma applied after resize (0/undefined = none). Recovers
   *  crispness lost to upscaling, e.g. the 293S's 72→85 enlarge. Adds high-
   *  frequency detail → larger JPEG, so keep modest (~0.4–0.8). */
  sharpen?: number;
  /** Pixels to trim from every side of the source image before rotate/flip/resize
   *  (0/undefined = none). The K1 Pro is fed an 80×80 Mini BMP whose outer edge
   *  is dead border; crop 6 → 68×68 before the 64×64 resize. Ignored when it
   *  would leave a non-positive dimension. */
  crop?: number;
  /** JPEG resize filter; default 'triangle'. K1 Pro uses 'nearest' to match
   *  the known-good keydeck/mirajazz encoder recipe. 'lanczos3' gives best
   *  quality for upscaling (e.g. 293: 72→112). */
  resizeFilter?: 'triangle' | 'nearest' | 'lanczos3';
  /** How the CORA image is fitted to width×height.
   *  'resize' (default) — interpolate to the panel size (may blur on upscale).
   *  'pad' — keep source pixels 1:1, centre in the canvas, fill the border per `padFill`.
   *          Centring uses a floor split (top-left bias). Inputs larger than the canvas
   *          fall back to 'resize'. Used by the 293S: app sends 72×72, panel is 85×85. */
  resizeMode?: 'resize' | 'pad';
  /** Border fill for resizeMode:'pad'. 'edge' (default) = clamp-to-edge replicate;
   *  'black' = black border; 'average' = mean source colour. Ignored for 'resize'. */
  padFill?: 'black' | 'average' | 'edge';
  /** How image-pipeline routes a CORA JPEG to this device's native format.
   *  'passthrough' — send the CORA JPEG unchanged (only valid when the device
   *  consumes CORA-native resolution: rotate 0, no flip, no maxBytes cap).
   *  'sidecar' — resize/rotate/flip via the Rust sidecar.
   *  The `format: 'bmp'` short-circuit in image-pipeline runs first regardless. */
  transform: 'passthrough' | 'sidecar';
}

/** Low-level wire behavior for the Mirabox CORA protocols (mirabox-cora / -v1). */
export interface DeviceWireSpec {
  packetSize: number; // 1024 (v3) / 512 (v1)
  inSize: number; // HID read buffer size
  heartbeatMs?: number; // undefined = no heartbeat
  synthesizeKeyUp: boolean; // v1 sends keydown only — synthesize the keyup
  sendStpAfterImage: boolean; // v3 sends CRT STP after image/clear; v1 doesn't
  /** HID report-ID prefix byte: 0x00 (293 default) or 0x04 (K1 Pro). Defaults to 0x00. */
  reportId?: number;
  /** K1 Pro firmware drops the last byte of every full packetSize image chunk.
   *  When true, sendImage wire-encodes the JPEG with one sacrificial byte after
   *  every (packetSize - 1) payload bytes, so the drop only ever eats padding.
   *  Hardware-verified probe round 16 — see jpeg-artifact-findings.md. */
  chunkPadByte?: boolean;
  /** v1 firmware reports a hardcoded serial shared by every unit of every v1 model
   *  (`355499441494`), so a serial alone can't identify a physical device. When true,
   *  deviceKeyFor() appends the model id to keep two different v1 decks apart.
   *  See mirajazz README "protocol_version = 1". */
  sharedSerial?: boolean;
  /** Milliseconds to busy-wait after each full image chunk (0/undefined = none).
   *  Some rebadged v3 boards drop image data when chunks arrive back-to-back;
   *  Lyagva's D6 fork PR #1 pairs `drawChunkDelayMs: 2` with sequential writes on
   *  the rev. 2 board. That fix targets node-hid's *async* writer firing every chunk
   *  through `Promise.all`; our worker writes chunks synchronously and in order, so
   *  no shipped model sets this — it exists so a device that still tears has a knob
   *  that doesn't need a code change. Costs chunkCount × ms of worker-thread time
   *  per image; leave it unset unless hardware demonstrably needs it. */
  chunkDelayMs?: number;
  /** When set, read the device's real output-report size out of its HID report
   *  descriptor at open() and use that instead of `packetSize` — but ONLY if the
   *  probed value is one of these. See devices/hid-report-descriptor.ts.
   *
   *  For boards whose packet size we inferred rather than measured. A wrong
   *  `packetSize` is otherwise undetectable at runtime: short writes are discarded by
   *  the firmware while `hid_write` still returns success, so the panel goes black with
   *  no error anywhere (opendeck-ampgd6 PR #7). Listing the sizes the family is known to
   *  use means the probe can only correct a guess, never invent an untested value. */
  packetSizeCandidates?: readonly number[];
}

/** CORA key index (MK.2, 0-based row-major) ↔ device wire ids.
 *
 *  Precedence (per direction, independent): explicit array > offset > identity.
 *    image : coraToWireImage[i]    ?? (imageOffset != null ? i + imageOffset : i)
 *    input : wireInputToCora[code] ?? (inputOffset != null ? code - inputOffset : code)
 *  The two directions are resolved separately: mirabox-293 uses an explicit
 *  `coraToWireImage` array for images but an `inputOffset` for input.
 *  Elgato devices omit both → identity mapping. */
export interface DeviceKeyMap {
  coraToWireImage?: readonly number[];
  wireInputToCora?: readonly number[]; // -1 entry = ignored key (293S 6th column)
  inputOffset?: number;
  imageOffset?: number;
  /** Physical keys outside the emulated CORA grid (device wire ids). They still
   *  emit key events but map to no mk2 index; DeckBridge-native actions bind to
   *  them (see extra-keys.ts). 293S right column = [16, 17, 18]. */
  extraKeys?: readonly number[];
}

/** How this device advertises itself to the Elgato desktop over CORA. */
export interface DeviceCoraSpec {
  productId: number; // PID advertised in CORA capabilities
  advertiseGeometry?: ChildGeometry; // omit = derive from this model's own geometry
  usePhysicalIdentity: boolean; // forward the device's real serial/firmware (Elgato true, Mirabox false)
}

/** Splash-screen overrides. model.image is calibrated for desktop-pre-rotated CORA
 *  frames; splash sources are upright, so some devices need an extra transform. */
export interface DeviceSplashSpec {
  keys?: readonly number[]; // CORA indices to fill; default = top-left block / all
  transformOverride?: { rotate?: 0 | 90 | 180 | 270; flipH?: boolean; flipV?: boolean };
}

/** Low-level wire behaviour for PAGE protocols (ulanzi-zk): devices that repaint
 *  the whole grid from one archive rather than accepting a per-key image write.
 *  Deliberately NOT folded into DeviceWireSpec — none of that struct's fields
 *  (sendStpAfterImage, synthesizeKeyUp, chunkPadByte, …) mean anything here, and
 *  keeping them apart stops Mirabox framing fields growing meanings they lack. */
export interface DevicePageSpec {
  packetSize: number; // 1024 for the D200 (both directions)
  inSize: number; // HID read buffer size
  /** Any outbound write resets the firmware's watchdog; with none it reverts to
   *  its own screen after ~5–10 s. We send a clock frame at this interval. */
  keepaliveMs: number;
  /** Coalescing window: CORA pushes one image per key, the device takes one ZIP
   *  per page, so staged images are batched for this long before a flush. */
  flushDebounceMs: number;
  /** Floor on the gap between two flushes — a page is ~180 synchronous HID
   *  writes, and unthrottled writers are reported to stall the firmware after
   *  ~17 min of animation. */
  minFlushIntervalMs: number;
  /** Use the partial-update opcode for flushes after the first full page.
   *  Disputed on hardware (ghost/white keys have been reported); false falls
   *  back to resending the whole remembered page every time. */
  partialUpdates: boolean;
  /** Firmware cap on one page archive (0 = unknown/uncapped). Oversized ZIPs are
   *  silently dropped rather than rejected, so this is only a diagnostic. */
  maxZipBytes: number;
  /** Firmware render mode for the wide info-window slot (203 = digital clock). */
  smallWindowMode: number;
  /** Grid position of that wide slot, as the manifest's "{col}_{row}" key. */
  smallWindowSlot: { col: number; row: number };
  /** Milliseconds to busy-wait between page chunks (0/undefined = none). Escape
   *  hatch for firmware that drops back-to-back 1024-byte writes. */
  chunkDelayMs?: number;
}

export type DriverKind = 'elgato-hid' | 'mirabox' | 'ulanzi' | 'custom';

/** Child geometry advertised to the Elgato desktop over CORA capabilities. */
export interface ChildGeometry {
  rows: number;
  columns: number;
  keyCount: number;
  keyWidth: number;
  keyHeight: number;
  productName: string;
}

export interface DeviceModel {
  id: DeviceModelId;
  vendor: DeviceVendor;
  protocol: DeviceProtocol;
  name: string;
  usbVendorId: number;
  usbProductIds: readonly number[];
  usagePage?: number;
  usage?: number;
  keyCount: number;
  columns: number;
  rows: number;
  keyWidth: number;
  keyHeight: number;
  image: DeviceImageSpec;
  /** Mirabox-only wire framing (packet sizes, heartbeat, STP/keyup quirks).
   *  Undefined for elgato-hid models — their framing lives in PROTOCOL_STRATEGY. */
  wire?: DeviceWireSpec;
  /** Page-protocol framing (ulanzi-zk only). Mutually exclusive with `wire`. */
  page?: DevicePageSpec;
  keyMap: DeviceKeyMap;
  cora: DeviceCoraSpec;
  splash?: DeviceSplashSpec;
  driverKind: DriverKind;
}

/** Common interface satisfied by every driver (real USB and mock). */
export interface DeviceDriver extends EventEmitter {
  readonly model: DeviceModel;
  /** `hidPath` (optional) opens a SPECIFIC HID interface — used to drive a second
   *  unit of the same model. Omitted → enumerate + open the first usage-matched
   *  path (primary probe). Ignored by MockDriver. */
  open(hidPath?: string): Promise<void>;
  close(): Promise<void>;
  /** keyIndex: CORA logical index (0-based).
   *  bytes: native image format for the device (JPEG for MK.2, BMP for Mini, JPEG for Mirabox). */
  sendImage(keyIndex: number, bytes: Uint8Array): void;
  clearKey(keyIndex: number): void;
  setBrightness(level: number): void;
  /** Present a raw CORA image on the device: transform (resize/rotate/encode),
   *  cache, and write it. Implemented only by the worker-backed real driver
   *  (`WorkerHidDriver`), which does the transform off the main thread (P1).
   *  Omitted by `MockDriver` (virtual device) and the low-level in-worker
   *  drivers (which only expose the native-bytes `sendImage`). */
  renderCoraImage?(keyIndex: number, coraBytes: Uint8Array, format: 'jpeg' | 'bmp'): void;
  /** Set (or clear, with null) a WebUI runtime image-fit override applied on
   *  top of this model's default resizeMode/padFill for subsequent
   *  `renderCoraImage` calls. Implemented only by `WorkerHidDriver`; omitted
   *  by `MockDriver` and the low-level in-worker drivers. */
  setImageOverride?(mode: ImageModeOverride): void;
  /** Send a splash source image: the worker transforms it with `spec` (which
   *  may differ from model.image due to splash orientation overrides) and writes
   *  the native bytes to the device. Implemented only by `WorkerHidDriver`;
   *  omitted by `MockDriver` (no USB device to write to). Offloads the
   *  50–200 ms synchronous FFI transform away from the main thread (P1). */
  sendSplashImage?(keyIndex: number, bytes: Uint8Array, spec: DeviceImageSpec): void;
}
