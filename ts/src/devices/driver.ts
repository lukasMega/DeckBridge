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
  | 'fifine';

/** Wire protocol — closed; adding a new model almost always reuses an existing one. */
export type DeviceProtocol =
  | 'mirabox-cora' // v3, 1024-byte packets, press+release
  | 'mirabox-cora-v1' // v1, 512-byte packets, keydown-only
  | 'ajazz-akp05' // 1024-byte CRT BAT uploads, ULEND commit
  | 'elgato-gen1' // BMP, 16-byte header, key+1, feature 0x05/0x0B (Mini, original)
  | 'elgato-gen2'; // JPEG, 8-byte header, feature 0x03 (MK.2, XL)

/** Stable kebab-case slug used as cache key, UI label, logs. */
// eslint-disable-next-line sonarjs/redundant-type-aliases
export type DeviceModelId = string;

export interface DeviceImageSpec {
  format: 'jpeg' | 'bmp';
  width: number;
  height: number;
  /** Extra CW rotation applied to the CORA JPEG before sending. CORA images are
   *  upright, so MK.2 needs 180 and Mini 90. */
  rotate: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
  colorMode: 'rgb' | 'bgr';
  bmpPpm?: number; // 2835 for Mini
  maxBytes: number; // JPEG size cap; 0 = no cap (BMP is fixed-size)
  quality: number; // JPEG only (0–1)
  blur?: number; // Gaussian blur sigma before JPEG encode (0 = none)
  /** Unsharp-mask sigma after resize (0 = none). Recovers crispness lost to
   *  upscaling (293S 72→85). Grows the JPEG, so keep ~0.4–0.8. */
  sharpen?: number;
  /** Pixels trimmed from every side before rotate/flip/resize (0 = none). K1 Pro is
   *  fed an 80×80 Mini BMP with a dead outer edge: crop 6 → 68×68, then resize to
   *  64×64. Ignored when it would leave a non-positive dimension. */
  crop?: number;
  /** JPEG resize filter; default 'triangle'. K1 Pro uses 'nearest' to match the
   *  known-good keydeck/mirajazz recipe; 'lanczos3' upscales best (293: 72→112). */
  resizeFilter?: 'triangle' | 'nearest' | 'lanczos3';
  /** How the CORA image is fitted to width×height. 'resize' (default) interpolates;
   *  'pad' keeps source pixels 1:1 and centres them (floor split, top-left bias),
   *  falling back to 'resize' when the source is larger. 293S: 72×72 into 85×85. */
  resizeMode?: 'resize' | 'pad';
  /** Border fill for resizeMode:'pad'. 'edge' (default) = clamp-to-edge replicate;
   *  'black' = black border; 'average' = mean source colour. Ignored for 'resize'. */
  padFill?: 'black' | 'average' | 'edge';
  /** How image-pipeline routes a CORA JPEG. 'passthrough' sends it unchanged — only
   *  valid at CORA-native resolution (rotate 0, no flip, no maxBytes cap); 'sidecar'
   *  resizes/rotates/flips. The `format: 'bmp'` short-circuit runs first regardless. */
  transform: 'passthrough' | 'sidecar';
}

/** Low-level HID behavior. `packetSize`/`inSize` are read by both driver families;
 *  the quirk flags are Mirabox-only, hence optional. An omitted flag silently reads
 *  `false`, so device-models.test.ts requires them on Mirabox models. */
export interface DeviceWireSpec {
  packetSize: number; // output-report size: 1024 (v3, elgato gen1/gen2) / 512 (v1)
  inSize: number; // HID read buffer size
  heartbeatMs?: number; // undefined = no heartbeat
  synthesizeKeyUp?: boolean; // v1 sends keydown only — synthesize the keyup
  /** One STP per image batch on supported 293S-family boards. */
  batchImageTransfers?: boolean;
  sendStpAfterImage?: boolean; // v3 sends CRT STP after image/clear; v1 doesn't
  /** HID report-ID prefix byte: 0x00 (293 default) or 0x04 (K1 Pro). Defaults to 0x00. */
  reportId?: number;
  /** K1 Pro firmware drops the last byte of every full image chunk. When true,
   *  sendImage inserts a sacrificial byte every (packetSize - 1) payload bytes so
   *  the drop only eats padding. See jpeg-artifact-findings.md. */
  chunkPadByte?: boolean;
  /** v1 firmware reports one hardcoded serial (`355499441494`) for every unit of every
   *  v1 model, so deviceKeyFor() appends the model id to keep two v1 decks apart. */
  sharedSerial?: boolean;
  /** Busy-wait after each full image chunk (0 = none). Some rebadged v3 boards tear
   *  on back-to-back chunks, but that fix targets node-hid's async writer — our worker
   *  already writes sequentially, so no shipped model sets this. Costs
   *  chunkCount × ms of worker time per image; leave unset unless hardware needs it. */
  chunkDelayMs?: number;
  /** When set, open() reads the real output-report size from the HID report descriptor
   *  and uses it instead of `packetSize`, but only if it is one of these. For boards
   *  whose packet size we inferred: a wrong one is otherwise invisible (the firmware
   *  discards short writes while `hid_write` still succeeds → black panel, no error).
   *  The whitelist lets the probe correct a guess, never invent an untested value. */
  packetSizeCandidates?: readonly number[];
}

/** CORA key index (MK.2, 0-based row-major) ↔ device wire ids. Each direction
 *  resolves independently — explicit array > offset > identity:
 *    image : coraToWireImage[i]    ?? (imageOffset != null ? i + imageOffset : i)
 *    input : wireInputToCora[code] ?? (inputOffset != null ? code - inputOffset : code) */
export interface DeviceKeyMap {
  coraToWireImage?: readonly number[];
  wireInputToCora?: readonly number[]; // -1 entry = ignored key (293S 6th column)
  inputOffset?: number;
  imageOffset?: number;
  /** Physical keys outside the emulated CORA grid (device wire ids): they emit key
   *  events but map to no mk2 index, so DeckBridge-native actions bind to them
   *  (extra-keys.ts). 293S right column = [16, 17, 18]. */
  extraKeys?: readonly number[];
}

/** How this device advertises itself to the Elgato desktop over CORA. */
export interface DeviceCoraSpec {
  productId: number; // PID advertised in CORA capabilities
  /** Registry model whose geometry this device emulates; omit for own geometry. */
  advertiseAs?: DeviceModelId;
  usePhysicalIdentity: boolean; // forward the device's real serial/firmware (Elgato true, Mirabox false)
  /** Firmware version string the CHILD reports over CORA (GET_REPORT 0x05 / 0x87).
   *  Omit for the shared DEFAULT_CHILD_FIRMWARE_VERSION ('1.01.000'); the Stream Deck +
   *  profile sets a 2.00.x version because the desktop rejects 1.01.x for PID 0x0084. */
  childFirmwareVersion?: string;
  /** When a model advertises AS this profile, also adopt this profile's `image` and
   *  `keyMap` (a full emulation, not just geometry). The Stream Deck + profile sets
   *  this because its 120×120 / 4×2 geometry needs a different physical rotation and
   *  key mapping than the AKP05E's native 5×2. Geometry-only profiles (mk2, mini) leave
   *  it unset so the 293S/K1 Pro keep their own image transform + key map. */
  fullEmulation?: boolean;
}

/** Splash-screen overrides. model.image is calibrated for desktop-pre-rotated CORA
 *  frames; splash sources are upright, so some devices need an extra transform. */
export interface DeviceSplashSpec {
  keys?: readonly number[]; // CORA indices to fill; default = top-left block / all
  transformOverride?: { rotate?: 0 | 90 | 180 | 270; flipH?: boolean; flipV?: boolean };
}

/** A device-native display outside CORA's key grid, rendered by DeckBridge widgets. */
export interface DeviceWidgetDisplay {
  wireId: number;
  label: string;
  image: DeviceImageSpec;
}

export type DriverKind = 'elgato-hid' | 'mirabox' | 'custom';

/** Child geometry advertised to the Elgato desktop over CORA capabilities. The
 *  optional fields describe a Stream Deck + (encoders + touch strip); non-Plus
 *  models omit them (undefined → 0 → "no encoders / no touch" in the packet). */
export interface ChildGeometry {
  rows: number;
  columns: number;
  keyCount: number;
  keyWidth: number;
  keyHeight: number;
  productName: string;
  /** Number of rotaries (Plus = 4). Omitted/0 on key-only models. */
  encoderCount?: number;
  /** Touch-strip size in pixels (Plus = 800×100). Omitted/0 on key-only models. */
  touchWidth?: number;
  touchHeight?: number;
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
  /** Stream Deck + only: rotary encoder count (4) and touch-strip size (800×100).
   *  Omitted/undefined on key-only models → advertised as 0 (no encoders/touch). */
  encoderCount?: number;
  touchWidth?: number;
  touchHeight?: number;
  image: DeviceImageSpec;
  wire: DeviceWireSpec;
  keyMap: DeviceKeyMap;
  cora: DeviceCoraSpec;
  splash?: DeviceSplashSpec;
  widgetDisplays?: readonly DeviceWidgetDisplay[];
  driverKind: DriverKind;
}

/** Only the 512-byte, keydown-only 293S board family supports this tuning. */
export function supportsImageBatching(model: DeviceModel): boolean {
  return model.driverKind === 'mirabox' && model.protocol === 'mirabox-cora-v1';
}

// The tunable field names, listed once: they type DeviceModelOverride below and drive
// the validator/seed tables in devices/model-overrides.ts, which can't drift from them.
export const IMAGE_OVERRIDE_KEYS = [
  'rotate',
  'flipH',
  'flipV',
  'width',
  'height',
  'quality',
  'maxBytes',
  'blur',
  'sharpen',
  'crop',
  'resizeFilter',
  'resizeMode',
  'padFill',
  'transform',
] as const;

export const WIRE_OVERRIDE_KEYS = [
  'packetSize',
  'inSize',
  'heartbeatMs',
  'reportId',
  'chunkDelayMs',
  'chunkPadByte',
  'synthesizeKeyUp',
  'sendStpAfterImage',
  'batchImageTransfers',
] as const;

/** The CORA-emulation fields a user may change to re-pair a device as a different
 *  Elgato deck (e.g. AKP05E → Stream Deck +). `advertiseAs` selects the geometry
 *  source, `productId` the advertised PID; both must agree, so the WebUI sets them
 *  together. `usePhysicalIdentity` is deliberately absent — it is a physical-device
 *  fact, not a pairing preference. */
export const CORA_OVERRIDE_KEYS = ['advertiseAs', 'productId'] as const;

/** User-tunable subset of a DeviceModel, persisted per model id under settings.json's
 *  `modelOverrides` (devices/model-overrides.ts). Deep-partial per section, arrays
 *  replace wholesale. Omissions are deliberate: VID/PID/protocol/driverKind would
 *  impersonate a different device, keyCount/rows/columns force a CORA re-pair,
 *  image.format is a protocol fact, and packetSize/inSize are Mirabox-only.
 *  The `cora` section is the sanctioned exception: `advertiseAs`/`productId` are
 *  exactly the "re-pair as a different Elgato deck" knob (opt-in, changes geometry +
 *  PID → CORA re-pair). */
export interface DeviceModelOverride {
  image?: Partial<Pick<DeviceImageSpec, (typeof IMAGE_OVERRIDE_KEYS)[number]>>;
  keyMap?: Partial<DeviceKeyMap>;
  wire?: Partial<Pick<DeviceWireSpec, (typeof WIRE_OVERRIDE_KEYS)[number]>>;
  splash?: DeviceSplashSpec;
  cora?: Partial<Pick<DeviceCoraSpec, (typeof CORA_OVERRIDE_KEYS)[number]>>;
}

/** Common interface satisfied by every driver (real USB and mock). */
export interface DeviceDriver extends EventEmitter {
  /** The effective model this driver is running. Swapped in place by
   *  `applyOverrides` for a live (image-only) device-tuning change, so callers
   *  must read it per use rather than caching `driver.model.image`. */
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
  /** Transform (resize/rotate/encode), cache and write a raw CORA image. Only
   *  `WorkerHidDriver` implements it, doing the transform off the main thread;
   *  `MockDriver` and the in-worker drivers expose native-bytes `sendImage` only. */
  renderCoraImage?(keyIndex: number, coraBytes: Uint8Array, format: 'jpeg' | 'bmp'): void;
  /** Set (null clears) a WebUI image-fit override on top of this model's
   *  resizeMode/padFill for later `renderCoraImage` calls. `WorkerHidDriver` only. */
  setImageOverride?(mode: ImageModeOverride): void;
  /** Send a splash source image, transformed with `spec` (which may differ from
   *  model.image — splash sources are upright). `WorkerHidDriver` only, keeping the
   *  FFI transform and hid_write burst off the main thread. */
  sendSplashImage?(keyIndex: number, bytes: Uint8Array, spec: DeviceImageSpec): void;
  /** Render a Stream Deck + window-strip image (800×100 JPEG) to the device's
   *  touch-segment displays. `WorkerHidDriver` only. No-op on models without
   *  widget displays. */
  renderTouchImage?(bytes: Uint8Array): void;
  /** Live device-tuning swap — image-transform fields only, no reopen. The
   *  caller resolves `effectiveModel` (registry + overrides) and must have
   *  classified the change as 'live' first (classifyOverrideChange). Absent
   *  means the caller has to reopen instead. */
  applyOverrides?(overrides: DeviceModelOverride | undefined, effectiveModel: DeviceModel): void;
}
