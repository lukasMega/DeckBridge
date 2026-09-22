// Validate + merge user model overrides on top of a registry-resolved DeviceModel.
// Pure — no I/O/FFI — runs on main thread and USB worker. Applied ON TOP of a resolved
// model, never in place of one; excluded fields mean it can't smuggle in a different driver.
import {
  CORA_OVERRIDE_KEYS,
  IMAGE_OVERRIDE_KEYS,
  WIRE_OVERRIDE_KEYS,
  supportsImageBatching,
  type DeviceCoraSpec,
  type DeviceImageSpec,
  type DeviceKeyMap,
  type DeviceModel,
  type DeviceModelOverride,
  type DeviceSplashSpec,
  type DeviceWireSpec,
} from './driver.js';
import { fnv1aHex } from '../types.js';

export type ValidationResult =
  | { ok: true; value: DeviceModelOverride }
  | { ok: false; errors: string[] };

const ROTATIONS = [0, 90, 180, 270];
const RESIZE_FILTERS = ['triangle', 'nearest', 'lanczos3'];
const RESIZE_MODES = ['resize', 'pad'];
const PAD_FILLS = ['black', 'average', 'edge'];
const TRANSFORMS = ['passthrough', 'sidecar'];
const PACKET_SIZES = [512, 1024];

const KEYMAP_KEYS = [
  'coraToWireImage',
  'wireInputToCora',
  'inputOffset',
  'imageOffset',
  'extraKeys',
] as const;
const SECTION_KEYS = ['image', 'keyMap', 'wire', 'splash', 'cora'] as const;

type WireOverrideKey = (typeof WIRE_OVERRIDE_KEYS)[number];

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

/** One rule per tunable field. The tables below are the single source for both the
 *  per-field checks and the allowed-key list of their section. */
type FieldSpec =
  | { kind: 'enum'; values: readonly (string | number)[] }
  | { kind: 'string'; max?: number }
  | { kind: 'boolean' }
  | { kind: 'number'; min?: number; max?: number; integer?: boolean }
  | { kind: 'ints'; min: number; length?: (model: DeviceModel) => number }
  | { kind: 'object'; fields: SectionFields };

type SectionFields = Record<string, FieldSpec>;

const IMAGE_FIELDS: Record<(typeof IMAGE_OVERRIDE_KEYS)[number], FieldSpec> = {
  rotate: { kind: 'enum', values: ROTATIONS },
  flipH: { kind: 'boolean' },
  flipV: { kind: 'boolean' },
  width: { kind: 'number', min: MIN_DIMENSION, max: MAX_DIMENSION, integer: true },
  height: { kind: 'number', min: MIN_DIMENSION, max: MAX_DIMENSION, integer: true },
  quality: { kind: 'number', min: MIN_QUALITY, max: MAX_QUALITY },
  // 0 = no cap (BMP is fixed-size), so the floor is 0, not 1.
  maxBytes: { kind: 'number', min: 0, integer: true },
  blur: { kind: 'number', min: 0 },
  sharpen: { kind: 'number', min: 0 },
  crop: { kind: 'number', min: 0, integer: true },
  resizeFilter: { kind: 'enum', values: RESIZE_FILTERS },
  resizeMode: { kind: 'enum', values: RESIZE_MODES },
  padFill: { kind: 'enum', values: PAD_FILLS },
  transform: { kind: 'enum', values: TRANSFORMS },
};

const KEYMAP_FIELDS: Record<(typeof KEYMAP_KEYS)[number], FieldSpec> = {
  // One entry per emulated key, in CORA index order — a short array would leave
  // keys unmapped with no error at render time.
  coraToWireImage: { kind: 'ints', min: 0, length: (model) => model.keyCount },
  wireInputToCora: { kind: 'ints', min: -1 },
  inputOffset: { kind: 'number', integer: true },
  imageOffset: { kind: 'number', integer: true },
  extraKeys: { kind: 'ints', min: 0 },
};

const WIRE_FIELDS: Record<WireOverrideKey, FieldSpec> = {
  packetSize: { kind: 'enum', values: PACKET_SIZES },
  inSize: { kind: 'number', min: 1, max: MAX_IN_SIZE, integer: true },
  heartbeatMs: { kind: 'number', min: 0, integer: true },
  reportId: { kind: 'number', min: 0, max: 255, integer: true },
  chunkDelayMs: { kind: 'number', min: 0, integer: true },
  chunkPadByte: { kind: 'boolean' },
  synthesizeKeyUp: { kind: 'boolean' },
  sendStpAfterImage: { kind: 'boolean' },
  batchImageTransfers: { kind: 'boolean' },
};

const TRANSFORM_OVERRIDE_FIELDS: SectionFields = {
  rotate: { kind: 'enum', values: ROTATIONS },
  flipH: { kind: 'boolean' },
  flipV: { kind: 'boolean' },
};

type CoraOverrideKey = (typeof CORA_OVERRIDE_KEYS)[number];

const CORA_FIELDS: Record<CoraOverrideKey, FieldSpec> = {
  advertiseAs: { kind: 'string', max: 64 },
  productId: { kind: 'number', min: 0, max: 0xffff, integer: true },
};

const SPLASH_FIELDS: SectionFields = {
  keys: { kind: 'ints', min: 0 },
  transformOverride: { kind: 'object', fields: TRANSFORM_OVERRIDE_FIELDS },
};

function checkNumber(
  value: unknown,
  spec: { min?: number; max?: number; integer?: boolean },
  path: string,
  errors: Errors,
): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${path}: must be a finite number`);
    return;
  }
  if (spec.integer && !Number.isInteger(value)) errors.push(`${path}: must be an integer`);
  if (spec.min !== undefined && value < spec.min) errors.push(`${path}: must be ≥ ${spec.min}`);
  if (spec.max !== undefined && value > spec.max) errors.push(`${path}: must be ≤ ${spec.max}`);
}

/** `spec.min` is -1 for wireInputToCora (an ignored key, e.g. the 293S 6th column). */
function checkIntArray(
  value: unknown,
  spec: { min: number; length?: (model: DeviceModel) => number },
  path: string,
  model: DeviceModel,
  errors: Errors,
): void {
  if (!Array.isArray(value)) {
    errors.push(`${path}: must be an array of integers`);
    return;
  }
  const length = spec.length?.(model);
  if (length !== undefined && value.length !== length) {
    errors.push(`${path}: must have exactly ${length} entries (got ${value.length})`);
  }
  if (!value.every((v) => typeof v === 'number' && Number.isInteger(v) && v >= spec.min)) {
    errors.push(`${path}: every entry must be an integer ≥ ${spec.min}`);
  }
}

function checkField(
  value: unknown,
  spec: FieldSpec,
  path: string,
  model: DeviceModel,
  errors: Errors,
): void {
  if (value === undefined) return;
  switch (spec.kind) {
    case 'number':
      return checkNumber(value, spec, path, errors);
    case 'ints':
      return checkIntArray(value, spec, path, model, errors);
    case 'object':
      validateSection(value, spec.fields, path, model, errors);
      return;
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${path}: must be a boolean`);
      return;
    case 'string':
      if (typeof value !== 'string') errors.push(`${path}: must be a string`);
      else if (spec.max !== undefined && value.length > spec.max)
        errors.push(`${path}: must be ≤ ${spec.max} characters`);
      return;
    case 'enum':
      if (!spec.values.includes(value as string)) {
        errors.push(`${path}: must be one of ${spec.values.join(', ')}`);
      }
  }
}

/** Returns whether `raw` was an object at all, so a caller with extra section-level
 *  rules (validateWire) can skip them on a non-object. */
function validateSection(
  raw: unknown,
  fields: SectionFields,
  path: string,
  model: DeviceModel,
  errors: Errors,
): raw is Record<string, unknown> {
  if (!isPlainObject(raw)) {
    errors.push(`${path}: must be an object`);
    return false;
  }
  rejectUnknownKeys(raw, Object.keys(fields), path, errors);
  for (const [key, spec] of Object.entries(fields)) {
    checkField(raw[key], spec, `${path}.${key}`, model, errors);
  }
  return true;
}

function validateWire(raw: unknown, model: DeviceModel, errors: Errors): void {
  if (!validateSection(raw, WIRE_FIELDS, 'wire', model, errors)) return;
  if (raw.batchImageTransfers !== undefined && !supportsImageBatching(model)) {
    errors.push(
      `wire.batchImageTransfers: not tunable on ${model.name} — requires a 293S-family board`,
    );
  }
  if (model.driverKind !== 'elgato-hid') return;
  for (const key of ELGATO_FIXED_WIRE_KEYS) {
    if (raw[key] !== undefined) {
      errors.push(
        `wire.${key}: not tunable on ${model.name} — fixed by the ${model.protocol} protocol`,
      );
    }
  }
}

/** Strict, model-aware validation. Returns every error found (not just the first)
 *  so the UI can show the whole list at once. */
export function validateModelOverride(raw: unknown, model: DeviceModel): ValidationResult {
  if (!isPlainObject(raw)) return { ok: false, errors: ['override must be an object'] };
  const errors: Errors = [];
  rejectUnknownKeys(raw, SECTION_KEYS, 'override', errors);
  if (raw.image !== undefined) validateSection(raw.image, IMAGE_FIELDS, 'image', model, errors);
  if (raw.keyMap !== undefined) validateSection(raw.keyMap, KEYMAP_FIELDS, 'keyMap', model, errors);
  if (raw.wire !== undefined) validateWire(raw.wire, model, errors);
  if (raw.splash !== undefined) validateSection(raw.splash, SPLASH_FIELDS, 'splash', model, errors);
  if (raw.cora !== undefined) validateSection(raw.cora, CORA_FIELDS, 'cora', model, errors);
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
  const cora: DeviceCoraSpec = { ...model.cora, ...defined(ov.cora) };
  return {
    ...model,
    image,
    keyMap,
    wire,
    cora,
    ...(splash ? { splash } : {}),
  };
}

/** True when device tuning pins the image fit (`image.resizeMode`/`padFill`).
 *  The legacy per-device `imageModeOverride` (types.ts, applied last in
 *  image-render.ts) would otherwise silently overwrite it, making the tuning
 *  form's "Image fit" control a no-op. Tuning wins; see docs/troubleshooting.md. */
export function pinsImageFit(ov?: DeviceModelOverride): boolean {
  return ov?.image?.resizeMode !== undefined || ov?.image?.padFill !== undefined;
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

/** What applying a new override over the previous one costs the live device.
 *  'live' = image-transform fields only, swappable in place (no driver reads
 *  model.image — only image-render.ts/translator.ts do); 'reopen' = keyMap,
 *  wire or splash changed, all of which are read at open(). */
export type OverrideChangeKind = 'none' | 'live' | 'reopen';

const OPEN_TIME_SECTIONS = ['keyMap', 'wire', 'splash', 'cora'] as const;

/** Canonical form of one override section: key order and absent-vs-undefined
 *  normalized, so `{}`, `undefined` and `{ rotate: undefined }` all compare equal. */
function sectionKey(
  ov: DeviceModelOverride | undefined,
  section: (typeof SECTION_KEYS)[number],
): string {
  const value = ov?.[section];
  if (!value || typeof value !== 'object') return '';
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .toSorted(([a], [b]) => (a < b ? -1 : 1));
  return entries.length > 0 ? JSON.stringify(entries) : '';
}

export function classifyOverrideChange(
  prev: DeviceModelOverride | undefined,
  next: DeviceModelOverride | undefined,
): OverrideChangeKind {
  for (const section of OPEN_TIME_SECTIONS) {
    if (sectionKey(prev, section) !== sectionKey(next, section)) return 'reopen';
  }
  return sectionKey(prev, 'image') === sectionKey(next, 'image') ? 'none' : 'live';
}

/** Short stable hash of an override, mixed into the image-cache key so a spec
 *  change can't be served a stale entry (see image-render.ts). '' when there is
 *  no override, keeping cache keys identical to the pre-override format. */
export function overrideRevision(ov?: DeviceModelOverride): string {
  if (!ov || Object.keys(ov).length === 0) return '';
  // Only the image section can change transform output; keyMap/wire/splash
  // affect routing and framing, not the encoded bytes.
  return fnv1aHex(JSON.stringify(ov.image ?? {}));
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
function tunableWireKeys(model: DeviceModel): readonly WireOverrideKey[] {
  return WIRE_OVERRIDE_KEYS.filter(
    (key) =>
      (key !== 'batchImageTransfers' || supportsImageBatching(model)) &&
      (model.driverKind !== 'elgato-hid' || !ELGATO_FIXED_WIRE_KEYS.includes(key as never)),
  );
}

/** Tunable fields at their current (post-override) values — seeds the Device tuning
 *  form so every control starts at what the device actually uses. */
export function tunableDefaults(model: DeviceModel): DeviceModelOverride {
  const { image, keyMap, wire, splash, cora } = model;
  return {
    image: project(image, IMAGE_OVERRIDE_KEYS),
    keyMap: project(keyMap, KEYMAP_KEYS),
    wire: project(wire, tunableWireKeys(model)),
    ...(splash ? { splash } : {}),
    cora: project(cora, CORA_OVERRIDE_KEYS),
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
