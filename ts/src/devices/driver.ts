import type { EventEmitter } from 'node:events';
import type { TouchStripOptions, TouchWindowRegion } from '../shared/types.js';
import { PROTOCOLS, WIRE_OVERRIDE_KEYS, type WireOverrideKey } from './protocol-metadata.js';

// Re-exported so importers keep reading it from driver.ts.
export { WIRE_OVERRIDE_KEYS };

/** Kebab-case slug (checked by validate-model.ts); a new vendor needs no type edit. */
// eslint-disable-next-line sonarjs/redundant-type-aliases
export type DeviceVendor = string;

/** Wire protocol — closed; the table is PROTOCOLS in protocol-metadata.ts. */
export type DeviceProtocol = keyof typeof PROTOCOLS;

/** Stable kebab-case slug used as cache key, UI label, logs. */
// eslint-disable-next-line sonarjs/redundant-type-aliases
export type DeviceModelId = string;

export interface DeviceCropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

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
  /** Source-pixel region cut out before rotate/flip/fit, so the fit step sees only this
   *  part of the Elgato app's image (off-centre art, a one-sided dead border). Clamped
   *  to the source; cannot be combined with `crop`. */
  cropRect?: DeviceCropRect;
  /** JPEG resize filter; default 'triangle'. K1 Pro uses 'nearest' to match the
   *  known-good keydeck/mirajazz recipe; 'lanczos3' upscales best (293: 72→112). */
  resizeFilter?: 'triangle' | 'nearest' | 'lanczos3';
  /** How the CORA image is fitted to width×height. 'resize' (default) interpolates;
   *  'pad' keeps source pixels 1:1 and centres them (floor split, top-left bias),
   *  falling back to 'resize' when the source is larger. 293S: 72×72 into 85×85.
   *  'crop' is 'pad' that centre-crops larger axes instead of resizing — 1:1, no
   *  resampling (Stream Deck + 120×120 art on a 112×112 AKP05E key). */
  resizeMode?: 'resize' | 'pad' | 'crop';
  /** Border fill for resizeMode 'pad'/'crop'. 'edge' (default) = clamp-to-edge replicate;
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
  /** Input code of each `extraKeys` entry, same order, for extra keys that have a
   *  switch (their press runs a DeckBridge command). Absent = display-only keys. */
  extraKeyInputs?: readonly number[];
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
  /** CORA profiles (registry.ts `CORA_PROFILES` ids) this device may re-pair as via a
   *  `cora.advertiseAs` override, each with the physical image transform + key map the
   *  emulated grid needs on this panel. Only these (or the model's own `advertiseAs`)
   *  validate, so a profile can never land on hardware it has no mapping for. */
  emulations?: Readonly<Record<DeviceModelId, DeviceEmulation>>;
}

/** How a device drives its own panel while re-paired as a CORA profile (e.g. the
 *  AKP05E's 5×2 panel showing a Stream Deck + 4×2 grid). */
export interface DeviceEmulation {
  image: DeviceImageSpec;
  keyMap: DeviceKeyMap;
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
  /** Left edge of this display's window on the full strip, in strip pixels. Only
   *  meaningful with `DeviceModel.touchStripDisplay`. */
  stripX?: number;
}

/** One image across the whole touch strip. Its wire id may also be a widget
 *  display: the firmware draws each upload at its real size from the slot origin. */
export interface DeviceTouchStripDisplay {
  wireId: number;
  image: DeviceImageSpec;
}

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
  touchStripDisplay?: DeviceTouchStripDisplay;
  /** Hardware screen-off. Set only after the HAN hardware spike passes on that model
   *  (.claude/plans/2026-09-30_standby-burn-in-care.md, Task 0 item 4); not tunable. */
  sleep?: 'mirabox-han';
}

/** Elgato's own HID protocol (MK.2/Mini/…), as opposed to a Mirabox-family board. */
export function isElgatoHid(model: DeviceModel): boolean {
  return PROTOCOLS[model.protocol].family === 'elgato';
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
  'cropRect',
  'resizeFilter',
  'resizeMode',
  'padFill',
  'transform',
] as const;

/** Per-protocol tunable wire fields, read from PROTOCOLS (protocol-metadata.ts). */
export function tunableWireKeys(protocol: DeviceProtocol): readonly WireOverrideKey[] {
  return PROTOCOLS[protocol].tunableWireKeys;
}

/** One STP per image batch: decided here once for the worker queue and the driver. */
export function imageBatchingEnabled(model: DeviceModel): boolean {
  return (
    tunableWireKeys(model.protocol).includes('batchImageTransfers') &&
    model.wire.batchImageTransfers === true
  );
}

/** The CORA-emulation fields a user may change to re-pair a device as a different
 *  Elgato deck (e.g. AKP05E → Stream Deck +). `advertiseAs` must name one of the
 *  model's `cora.emulations` (or its own advertiseAs); `productId` must match that
 *  profile's PID. `usePhysicalIdentity` is deliberately absent — it is a
 *  physical-device fact, not a pairing preference. */
export const CORA_OVERRIDE_KEYS = ['advertiseAs', 'productId'] as const;

/** User-tunable subset of a DeviceModel, persisted per model id under settings.json's
 *  `modelOverrides` (devices/model-overrides.ts). Deep-partial per section, arrays
 *  replace wholesale. Omissions are deliberate: VID/PID/protocol would
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

/** The base driver contract: model + open/close + the two direct writes. */
export interface DeviceDriver extends EventEmitter {
  /** The effective model this driver is running. Swapped in place by
   *  `applyOverrides` for a live (image-only) device-tuning change, so callers
   *  must read it per use rather than caching `driver.model.image`. */
  readonly model: DeviceModel;
  /** Opens exactly `hidPath`, a usage-matched interface from discovery (one per
   *  physical unit). Ignored by MockDriver. */
  open(hidPath: string): Promise<void>;
  close(): Promise<void>;
  clearKey(keyIndex: number): void;
  setBrightness(level: number): void;
  /** Hardware screen-off / wake. Only drivers whose model sets `sleep` implement it. */
  setSleep?(asleep: boolean): void;
}

/** What a Dock drives on the main thread: `WorkerHidDriver` (the USB worker proxy)
 *  or `MockDriver`, whose versions of the worker-only calls are no-ops. */
export interface DockDriver extends DeviceDriver {
  /** Transform (resize/rotate/encode), cache and write a raw CORA image, off the
   *  main thread; the in-worker drivers take native bytes via their own `sendImage`.
   *  Emits `'frameHash'(coraKey, hash)` once the frame is rendered. */
  renderCoraImage(keyIndex: number, coraBytes: Uint8Array, format: 'jpeg' | 'bmp'): void;
  /** Send a splash source image, transformed with `spec` (which may differ from
   *  model.image — splash sources are upright), keeping the FFI transform and
   *  hid_write burst off the main thread. */
  sendSplashImage(keyIndex: number, bytes: Uint8Array, spec: DeviceImageSpec): void;
  /** Render a Stream Deck + window image (800×100, or a partial-window region)
   *  to the device's touch-segment displays. No-op on models without widget displays. */
  renderTouchImage(bytes: Uint8Array, region?: TouchWindowRegion): void;
  /** Touch-strip wire ids DeckBridge owns: Elgato strip images skip them, and a
   *  zone leaving the mask gets the last Elgato image back. */
  setTouchStripMask(wireIds: readonly number[]): void;
  /** Put the last Elgato image back on these strip zones (cleared if the app never
   *  drew one) — a widget leaving an unmasked zone. */
  restoreTouchSegments(wireIds: readonly number[]): void;
  /** Zone fit + upload policy for a full-strip model (settings.json, per dock). The
   *  worker resets them to the defaults on open. */
  setTouchStripOptions(options: TouchStripOptions): void;
  /** The options last set (defaults after open). */
  readonly touchStripOptions: TouchStripOptions;
  /** Live device-tuning swap — image-transform fields only, no reopen. The
   *  caller resolves `effectiveModel` (registry + overrides) and must have
   *  classified the change as 'live' first (classifyOverrideChange). */
  applyOverrides(overrides: DeviceModelOverride | undefined, effectiveModel: DeviceModel): void;
  /** Runtime log-level change for the worker (new workers read DECKBRIDGE_LOG_LEVEL). */
  setLogLevel(level: string): void;
  /** False on a driver that ignores splash/widget images (the browser deck): standby's
   *  clock can't show there. Absent = paints. */
  readonly paintsSplash?: boolean;
  /** Take images again after an 'overload' event, once the producer has resynced
   *  (a fresh CORA child session). Absent on drivers without a bounded queue. */
  resumeImages?(): void;
}
