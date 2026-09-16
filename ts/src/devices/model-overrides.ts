// Validate + merge user model overrides on top of a registry-resolved DeviceModel.
// Pure — no I/O/FFI — runs on main thread and USB worker. Applied ON TOP of a resolved
// model, never in place of one; excluded fields mean it can't smuggle in a different driver.
import type {
  DeviceImageSpec,
  DeviceKeyMap,
  DeviceModel,
  DeviceModelOverride,
  DeviceSplashSpec,
  DeviceWireSpec,
} from './driver.js';

export type ValidationResult =
  | { ok: true; value: DeviceModelOverride }
  | { ok: false; errors: string[] };

const ROTATIONS = [0, 90, 180, 270];
const RESIZE_FILTERS = ['triangle', 'nearest', 'lanczos3'];
const RESIZE_MODES = ['resize', 'pad'];
const PAD_FILLS = ['black', 'average', 'edge'];
const TRANSFORMS = ['passthrough', 'sidecar'];
const PACKET_SIZES = [512, 1024];

const IMAGE_KEYS = [
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
const KEYMAP_KEYS = [
  'coraToWireImage',
  'wireInputToCora',
  'inputOffset',
  'imageOffset',
  'extraKeys',
] as const;
const WIRE_KEYS = [
  'packetSize',
  'inSize',
  'heartbeatMs',
  'reportId',
  'chunkDelayMs',
  'chunkPadByte',
  'synthesizeKeyUp',
  'sendStpAfterImage',
] as const;
const SECTION_KEYS = ['image', 'keyMap', 'wire', 'splash'] as const;

/** Protocol facts on elgato-hid, not preferences: an unexpected `packetSize` makes
 *  gen1/gen2 chunk short, silently discarded by the firmware for a black panel with
 *  no error. MiraboxDriver genuinely tunes both. */
const ELGATO_FIXED_WIRE_KEYS = ['packetSize', 'inSize'] as const;

/** Bounds chosen to keep a typo from producing a device-bricking spec while
 *  still covering every panel we know of (64×64 K1 Pro … 112×112 293V3). */
const MIN_DIMENSION = 8;
const MAX_DIMENSION = 1024;
/** Ceiling on `inSize` (USB worker read buffer) — without one, `inSize: 2e9` in
 *  settings.json is a one-line OOM. Every known device asks for 512. */
const MAX_IN_SIZE = 4096;
// 0 = "not applicable", as for maxBytes: BMP models never JPEG-encode (the Mini ships
// `quality: 0`). Rejecting it would make a device's own registry value an invalid
// override — see the tunableDefaults invariant.
const MIN_QUALITY = 0;
const MAX_QUALITY = 1;

type Errors = string[];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Unknown keys are rejected, not silently dropped — a typo must surface in the
 *  UI rather than vanish and leave the user wondering why nothing changed. */
function rejectUnknownKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  errors: Errors,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) errors.push(`${path}.${key}: unknown field`);
  }
}

function checkEnum(
  value: unknown,
  allowed: readonly (string | number)[],
  path: string,
  errors: Errors,
): void {
  if (value !== undefined && !allowed.includes(value as string)) {
    errors.push(`${path}: must be one of ${allowed.join(', ')}`);
  }
}

function checkBoolean(value: unknown, path: string, errors: Errors): void {
  if (value !== undefined && typeof value !== 'boolean') errors.push(`${path}: must be a boolean`);
}

function checkNumber(
  value: unknown,
  path: string,
  errors: Errors,
  opts: { min?: number; max?: number; integer?: boolean } = {},
): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${path}: must be a finite number`);
    return;
  }
  if (opts.integer && !Number.isInteger(value)) errors.push(`${path}: must be an integer`);
  if (opts.min !== undefined && value < opts.min) errors.push(`${path}: must be ≥ ${opts.min}`);
  if (opts.max !== undefined && value > opts.max) errors.push(`${path}: must be ≤ ${opts.max}`);
}

function validateImage(raw: unknown, errors: Errors): void {
  if (!isPlainObject(raw)) {
    errors.push('image: must be an object');
    return;
  }
  rejectUnknownKeys(raw, IMAGE_KEYS, 'image', errors);
  checkEnum(raw.rotate, ROTATIONS, 'image.rotate', errors);
  checkBoolean(raw.flipH, 'image.flipH', errors);
  checkBoolean(raw.flipV, 'image.flipV', errors);
  checkNumber(raw.width, 'image.width', errors, {
    min: MIN_DIMENSION,
    max: MAX_DIMENSION,
    integer: true,
  });
  checkNumber(raw.height, 'image.height', errors, {
    min: MIN_DIMENSION,
    max: MAX_DIMENSION,
    integer: true,
  });
  checkNumber(raw.quality, 'image.quality', errors, { min: MIN_QUALITY, max: MAX_QUALITY });
  // 0 = no cap (BMP is fixed-size), so the floor is 0, not 1.
  checkNumber(raw.maxBytes, 'image.maxBytes', errors, { min: 0, integer: true });
  checkNumber(raw.blur, 'image.blur', errors, { min: 0 });
  checkNumber(raw.sharpen, 'image.sharpen', errors, { min: 0 });
  checkNumber(raw.crop, 'image.crop', errors, { min: 0, integer: true });
  checkEnum(raw.resizeFilter, RESIZE_FILTERS, 'image.resizeFilter', errors);
  checkEnum(raw.resizeMode, RESIZE_MODES, 'image.resizeMode', errors);
  checkEnum(raw.padFill, PAD_FILLS, 'image.padFill', errors);
  checkEnum(raw.transform, TRANSFORMS, 'image.transform', errors);
}

/** `min` is -1 for wireInputToCora (an ignored key, e.g. the 293S 6th column). */
function checkIntArray(
  value: unknown,
  path: string,
  errors: Errors,
  opts: { min: number; length?: number },
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push(`${path}: must be an array of integers`);
    return;
  }
  if (opts.length !== undefined && value.length !== opts.length) {
    errors.push(`${path}: must have exactly ${opts.length} entries (got ${value.length})`);
  }
  if (!value.every((v) => typeof v === 'number' && Number.isInteger(v) && v >= opts.min)) {
    errors.push(`${path}: every entry must be an integer ≥ ${opts.min}`);
  }
}

function validateKeyMap(raw: unknown, model: DeviceModel, errors: Errors): void {
  if (!isPlainObject(raw)) {
    errors.push('keyMap: must be an object');
    return;
  }
  rejectUnknownKeys(raw, KEYMAP_KEYS, 'keyMap', errors);
  // One entry per emulated key, in CORA index order — a short array would leave
  // keys unmapped with no error at render time.
  checkIntArray(raw.coraToWireImage, 'keyMap.coraToWireImage', errors, {
    min: 0,
    length: model.keyCount,
  });
  checkIntArray(raw.wireInputToCora, 'keyMap.wireInputToCora', errors, { min: -1 });
  checkIntArray(raw.extraKeys, 'keyMap.extraKeys', errors, { min: 0 });
  checkNumber(raw.inputOffset, 'keyMap.inputOffset', errors, { integer: true });
  checkNumber(raw.imageOffset, 'keyMap.imageOffset', errors, { integer: true });
}

function validateWire(raw: unknown, model: DeviceModel, errors: Errors): void {
  if (!isPlainObject(raw)) {
    errors.push('wire: must be an object');
    return;
  }
  rejectUnknownKeys(raw, WIRE_KEYS, 'wire', errors);
  if (model.driverKind === 'elgato-hid') {
    for (const key of ELGATO_FIXED_WIRE_KEYS) {
      if (raw[key] !== undefined) {
        errors.push(
          `wire.${key}: not tunable on ${model.name} — fixed by the ${model.protocol} protocol`,
        );
      }
    }
  }
  checkEnum(raw.packetSize, PACKET_SIZES, 'wire.packetSize', errors);
  checkNumber(raw.inSize, 'wire.inSize', errors, { min: 1, max: MAX_IN_SIZE, integer: true });
  checkNumber(raw.heartbeatMs, 'wire.heartbeatMs', errors, { min: 0, integer: true });
  checkNumber(raw.reportId, 'wire.reportId', errors, { min: 0, max: 255, integer: true });
  checkNumber(raw.chunkDelayMs, 'wire.chunkDelayMs', errors, { min: 0, integer: true });
  checkBoolean(raw.chunkPadByte, 'wire.chunkPadByte', errors);
  checkBoolean(raw.synthesizeKeyUp, 'wire.synthesizeKeyUp', errors);
  checkBoolean(raw.sendStpAfterImage, 'wire.sendStpAfterImage', errors);
}

function validateSplash(raw: unknown, errors: Errors): void {
  if (!isPlainObject(raw)) {
    errors.push('splash: must be an object');
    return;
  }
  rejectUnknownKeys(raw, ['keys', 'transformOverride'], 'splash', errors);
  checkIntArray(raw.keys, 'splash.keys', errors, { min: 0 });
  if (raw.transformOverride !== undefined) {
    if (!isPlainObject(raw.transformOverride)) {
      errors.push('splash.transformOverride: must be an object');
      return;
    }
    const t = raw.transformOverride;
    rejectUnknownKeys(t, ['rotate', 'flipH', 'flipV'], 'splash.transformOverride', errors);
    checkEnum(t.rotate, ROTATIONS, 'splash.transformOverride.rotate', errors);
    checkBoolean(t.flipH, 'splash.transformOverride.flipH', errors);
    checkBoolean(t.flipV, 'splash.transformOverride.flipV', errors);
  }
}

/** Strict, model-aware validation. Returns every error found (not just the first)
 *  so the UI can show the whole list at once. */
export function validateModelOverride(raw: unknown, model: DeviceModel): ValidationResult {
  if (!isPlainObject(raw)) return { ok: false, errors: ['override must be an object'] };
  const errors: Errors = [];
  rejectUnknownKeys(raw, SECTION_KEYS, 'override', errors);
  if (raw.image !== undefined) validateImage(raw.image, errors);
  if (raw.keyMap !== undefined) validateKeyMap(raw.keyMap, model, errors);
  if (raw.wire !== undefined) validateWire(raw.wire, model, errors);
  if (raw.splash !== undefined) validateSplash(raw.splash, errors);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: raw };
}

/** Drop `undefined` values so they can never overwrite a real model default
 *  (`{...spec, ...patch}` would otherwise set the field to undefined). */
function defined<T extends object>(patch: T | undefined): Partial<T> {
  if (!patch) return {};
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Apply `ov` on top of `model`, returning a NEW model (inputs untouched).
 *  Per-section shallow merge; arrays replace wholesale. `undefined` never wins. */
export function applyModelOverrides(model: DeviceModel, ov?: DeviceModelOverride): DeviceModel {
  if (!ov || Object.keys(ov).length === 0) return model;
  const image: DeviceImageSpec = { ...model.image, ...defined(ov.image) };
  const keyMap: DeviceKeyMap = { ...model.keyMap, ...defined(ov.keyMap) };
  const wire: DeviceWireSpec = { ...model.wire, ...defined(ov.wire) };
  const splash: DeviceSplashSpec | undefined = ov.splash ?? model.splash;
  return {
    ...model,
    image,
    keyMap,
    wire,
    ...(splash ? { splash } : {}),
  };
}

/** One-line summary for logs and the diagnostics header, so a bug report from a
 *  tuned device never reads as default behaviour. */
export function overrideSummary(ov?: DeviceModelOverride): string {
  if (!ov) return 'none';
  const parts: string[] = [];
  for (const section of SECTION_KEYS) {
    const value = ov[section];
    if (!value) continue;
    const keys = Object.keys(value);
    if (keys.length > 0) parts.push(`${section}{${keys.join(',')}}`);
  }
  return parts.length > 0 ? parts.join(' ') : 'none';
}

/** Short stable hash of an override, mixed into the image-cache key so a spec
 *  change can't be served a stale entry (see image-render.ts). '' when there is
 *  no override, keeping cache keys identical to the pre-override format. */
export function overrideRevision(ov?: DeviceModelOverride): string {
  if (!ov || Object.keys(ov).length === 0) return '';
  // Only the image section can change transform output; keyMap/wire/splash
  // affect routing and framing, not the encoded bytes.
  const text = JSON.stringify(ov.image ?? {});
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Copy exactly `keys` from `src`, skipping absent ones. Spreading the whole object
 *  would drag in non-tunable siblings (`image.format`, `wire.sharedSerial`, …), which
 *  validateModelOverride then rejects when the tuning form posts them back. */
function project<T extends object, K extends keyof T>(
  src: T,
  keys: readonly K[],
): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const key of keys) {
    if (src[key] !== undefined) out[key] = src[key];
  }
  return out;
}

/** The wire fields this model actually accepts as an override — everything for a Mirabox
 *  board, minus the protocol-fixed sizes for an elgato-hid one (ELGATO_FIXED_WIRE_KEYS). */
function tunableWireKeys(model: DeviceModel): readonly (keyof DeviceWireSpec)[] {
  if (model.driverKind !== 'elgato-hid') return WIRE_KEYS;
  return WIRE_KEYS.filter((k) => !ELGATO_FIXED_WIRE_KEYS.includes(k as never));
}

/** Tunable fields at their current (post-override) values — seeds the Device tuning
 *  form so every control starts at what the device actually uses. */
export function tunableDefaults(model: DeviceModel): DeviceModelOverride {
  const { image, keyMap, wire, splash } = model;
  return {
    image: project(image, IMAGE_KEYS),
    keyMap: project(keyMap, KEYMAP_KEYS),
    wire: project(wire, tunableWireKeys(model)),
    ...(splash ? { splash } : {}),
  };
}

/** Shape guard for a persisted/imported `modelOverrides` map. Model-aware
 *  validation needs the registry, so this only checks the outer shape; the full
 *  check runs in validateModelOverride at the route/probe boundary. */
export function isModelOverridesRecord(v: unknown): v is Record<string, DeviceModelOverride> {
  if (!isPlainObject(v)) return false;
  return Object.values(v).every(
    (entry) =>
      isPlainObject(entry) && Object.keys(entry).every((k) => SECTION_KEYS.includes(k as never)),
  );
}
