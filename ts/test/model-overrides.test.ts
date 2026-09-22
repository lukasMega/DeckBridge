import assert from 'tjs:assert';
import {
  applyModelOverrides,
  classifyOverrideChange,
  emulationProfiles,
  isModelOverridesRecord,
  overrideRevision,
  overrideSummary,
  pinsImageFit,
  tunableDefaults,
  validateModelOverride,
} from '../src/devices/model-overrides.js';
import type { DeviceModel } from '../src/devices/driver.js';
import { DEVICE_MODELS } from '../src/devices/registry.js';
import { MIRABOX_293_MODEL } from '../src/devices/mirabox/mirabox-293.js';
import { MK2_MODEL } from '../src/devices/elgato/mk2.js';
import { AJAZZ_AKP05E_MODEL } from '../src/devices/ajazz/akp05e.js';
import { ELGATO_MK2_PID, ELGATO_PLUS_PID } from '../src/types.js';
import { test, summary as reportSummary } from './helpers/harness.js';

const MODEL: DeviceModel = MIRABOX_293_MODEL;

test('image batching is tunable only on 293S-family boards', () => {
  for (const model of DEVICE_MODELS) {
    const supported = model.protocol === 'mirabox-cora-v1';
    for (const batchImageTransfers of [true, false]) {
      const result = validateModelOverride({ wire: { batchImageTransfers } }, model);
      assert.equal(result.ok, supported, model.id);
    }
    assert.equal(
      tunableDefaults(model).wire!.batchImageTransfers,
      supported ? model.id === 'mirabox-293s' : undefined,
      model.id,
    );
  }
  const model = DEVICE_MODELS.find((entry) => entry.id === 'mirabox-293s')!;
  const invalid = validateModelOverride({ wire: { batchImageTransfers: 1 } }, model);
  assert.equal(invalid.ok, false);
  assert.equal(
    applyModelOverrides(model, { wire: { batchImageTransfers: false } }).wire.batchImageTransfers,
    false,
  );
  assert.equal(model.wire.batchImageTransfers, true, 'override never mutates registry default');
});

/** The error list for a rejected override, or [] when it validated. */
function errorsFor(raw: unknown, model: DeviceModel = MODEL): string[] {
  const r = validateModelOverride(raw, model);
  return r.ok ? [] : r.errors;
}

function assertRejects(raw: unknown, needle: string, model: DeviceModel = MODEL): void {
  const errors = errorsFor(raw, model);
  assert.ok(errors.length > 0, `expected a rejection for ${JSON.stringify(raw)}`);
  assert.ok(
    errors.some((e) => e.includes(needle)),
    `expected an error mentioning "${needle}", got: ${errors.join('; ')}`,
  );
}

// validateModelOverride — shape

console.log('\nvalidateModelOverride — shape');

test('an empty object is valid (no tuning)', () => {
  assert.deepEqual(errorsFor({}), []);
});

test('a non-object is rejected', () => {
  assertRejects([], 'override must be an object');
  assertRejects('rotate', 'override must be an object');
  assertRejects(null, 'override must be an object');
});

test('unknown top-level sections are rejected, not dropped', () => {
  assertRejects({ imagee: {} }, 'unknown field');
});

test('unknown fields inside a section are rejected, not dropped', () => {
  // A typo must surface in the UI rather than vanish and leave the user
  // wondering why the change did nothing.
  assertRejects({ image: { rotat: 90 } }, 'image.rotat');
  assertRejects({ wire: { packetSizes: 1024 } }, 'wire.packetSizes');
  assertRejects({ keyMap: { inputOffsets: 1 } }, 'keyMap.inputOffsets');
});

// validateModelOverride — image

console.log('\nvalidateModelOverride — image');

test('accepts the four legal rotations', () => {
  for (const rotate of [0, 90, 180, 270]) {
    assert.deepEqual(errorsFor({ image: { rotate } }), [], `rotate ${rotate}`);
  }
});

test('rejects any other rotation', () => {
  assertRejects({ image: { rotate: 45 } }, 'image.rotate');
  assertRejects({ image: { rotate: 360 } }, 'image.rotate');
  assertRejects({ image: { rotate: '90' } }, 'image.rotate');
});

test('quality must be within [0, 1]; 0 means "not applicable" (BMP models)', () => {
  assert.deepEqual(errorsFor({ image: { quality: 0.05 } }), []);
  assert.deepEqual(errorsFor({ image: { quality: 1 } }), []);
  // The Mini ships quality: 0 — it never JPEG-encodes. A device's own registry
  // value must always be a legal override.
  assert.deepEqual(errorsFor({ image: { quality: 0 } }), []);
  assertRejects({ image: { quality: -0.1 } }, 'image.quality');
  assertRejects({ image: { quality: 1.5 } }, 'image.quality');
});

test('width/height must be within [8, 1024] and integral', () => {
  assert.deepEqual(errorsFor({ image: { width: 8, height: 1024 } }), []);
  assertRejects({ image: { width: 7 } }, 'image.width');
  assertRejects({ image: { height: 2048 } }, 'image.height');
  assertRejects({ image: { width: 100.5 } }, 'image.width');
});

test('maxBytes 0 is legal (no cap); negative is not', () => {
  assert.deepEqual(errorsFor({ image: { maxBytes: 0 } }), []);
  assertRejects({ image: { maxBytes: -1 } }, 'image.maxBytes');
});

test('enum fields are checked against their member lists', () => {
  assert.deepEqual(errorsFor({ image: { resizeFilter: 'lanczos3' } }), []);
  assert.deepEqual(errorsFor({ image: { resizeMode: 'pad', padFill: 'edge' } }), []);
  assert.deepEqual(errorsFor({ image: { transform: 'passthrough' } }), []);
  assertRejects({ image: { resizeFilter: 'bicubic' } }, 'image.resizeFilter');
  assertRejects({ image: { resizeMode: 'stretch' } }, 'image.resizeMode');
  assertRejects({ image: { padFill: 'white' } }, 'image.padFill');
  assertRejects({ image: { transform: 'native' } }, 'image.transform');
});

test('flips must be booleans', () => {
  assert.deepEqual(errorsFor({ image: { flipH: true, flipV: false } }), []);
  assertRejects({ image: { flipH: 'yes' } }, 'image.flipH');
});

test('rejects fields excluded from tuning (format, colorMode, bmpPpm)', () => {
  // Excluding these is the safety story: format is a protocol fact, not a
  // preference, and neither is settable without changing what the wire means.
  assertRejects({ image: { format: 'bmp' } }, 'image.format');
  assertRejects({ image: { colorMode: 'bgr' } }, 'image.colorMode');
  assertRejects({ image: { bmpPpm: 2835 } }, 'image.bmpPpm');
});

// validateModelOverride — keyMap (the #67.1 path)

console.log('\nvalidateModelOverride — keyMap');

test('coraToWireImage must have exactly keyCount entries', () => {
  const good = Array.from({ length: MODEL.keyCount }, (_, i) => i + 1);
  assert.deepEqual(errorsFor({ keyMap: { coraToWireImage: good } }), []);
  assertRejects({ keyMap: { coraToWireImage: good.slice(1) } }, 'exactly');
  assertRejects({ keyMap: { coraToWireImage: [...good, 16] } }, 'exactly');
});

test('coraToWireImage entries must be non-negative integers', () => {
  const bad = Array.from({ length: MODEL.keyCount }, () => -1);
  assertRejects({ keyMap: { coraToWireImage: bad } }, 'keyMap.coraToWireImage');
});

test('wireInputToCora allows -1 (an ignored key) and has no length constraint', () => {
  // -1 is the registry's "display-only key" marker (293S 6th column); the array
  // is indexed BY WIRE ID, so its length is a property of the hardware.
  assert.deepEqual(errorsFor({ keyMap: { wireInputToCora: [-1, 0, 1, 2, -1] } }), []);
  assertRejects({ keyMap: { wireInputToCora: [-2] } }, 'keyMap.wireInputToCora');
  assertRejects({ keyMap: { wireInputToCora: [1.5] } }, 'keyMap.wireInputToCora');
});

test('offsets must be integers', () => {
  assert.deepEqual(errorsFor({ keyMap: { inputOffset: 1, imageOffset: -1 } }), []);
  assertRejects({ keyMap: { inputOffset: 0.5 } }, 'keyMap.inputOffset');
});

test('rejects fields excluded from tuning (keyCount, rows, columns, protocol, ids)', () => {
  // Changing these does not tune a device — it impersonates a different one, or
  // forces an Elgato re-pair.
  for (const field of ['keyCount', 'rows', 'columns', 'usbVendorId', 'protocol', 'driverKind']) {
    assertRejects({ [field]: 1 }, 'unknown field');
  }
});

// validateModelOverride — wire

console.log('\nvalidateModelOverride — wire');

test('packetSize is limited to the two sizes the family uses', () => {
  assert.deepEqual(errorsFor({ wire: { packetSize: 512 } }), []);
  assert.deepEqual(errorsFor({ wire: { packetSize: 1024 } }), []);
  assertRejects({ wire: { packetSize: 2048 } }, 'wire.packetSize');
});

test('reportId must fit in a byte', () => {
  assert.deepEqual(errorsFor({ wire: { reportId: 0x04 } }), []);
  assertRejects({ wire: { reportId: 256 } }, 'wire.reportId');
  assertRejects({ wire: { reportId: -1 } }, 'wire.reportId');
});

test('wire booleans are type-checked', () => {
  assert.deepEqual(errorsFor({ wire: { synthesizeKeyUp: true, chunkPadByte: false } }), []);
  assertRejects({ wire: { sendStpAfterImage: 1 } }, 'wire.sendStpAfterImage');
});

// validateModelOverride — splash

console.log('\nvalidateModelOverride — splash');

test('splash transformOverride accepts rotation + flips', () => {
  assert.deepEqual(errorsFor({ splash: { transformOverride: { rotate: 180, flipH: true } } }), []);
  assertRejects(
    { splash: { transformOverride: { rotate: 1 } } },
    'splash.transformOverride.rotate',
  );
});

test('splash keys must be non-negative integers', () => {
  assert.deepEqual(errorsFor({ splash: { keys: [0, 1, 2] } }), []);
  assertRejects({ splash: { keys: [-1] } }, 'splash.keys');
});

// applyModelOverrides — merge semantics

console.log('\napplyModelOverrides');

test('no override returns the SAME model object', () => {
  assert.ok(applyModelOverrides(MODEL) === MODEL, 'undefined override');
  assert.ok(applyModelOverrides(MODEL, {}) === MODEL, 'empty override');
});

test('the registry model is never mutated', () => {
  const before = JSON.stringify(MODEL);
  applyModelOverrides(MODEL, { image: { rotate: 180 } });
  assert.equal(JSON.stringify(MODEL), before, 'registry stays ground truth');
});

test('per-section shallow merge keeps untouched fields', () => {
  const eff = applyModelOverrides(MODEL, { image: { rotate: 180 } });
  assert.equal(eff.image.rotate, 180);
  assert.equal(eff.image.width, MODEL.image.width, 'width untouched');
  assert.equal(eff.image.format, MODEL.image.format, 'format untouched');
  assert.deepEqual(eff.keyMap, MODEL.keyMap, 'other sections untouched');
});

test('arrays replace wholesale rather than merging element-wise', () => {
  const eff = applyModelOverrides(MODEL, { keyMap: { wireInputToCora: [2, 1, 0] } });
  assert.deepEqual(eff.keyMap.wireInputToCora, [2, 1, 0]);
});

test('undefined never overwrites a model default', () => {
  const eff = applyModelOverrides(MODEL, { image: { rotate: undefined, quality: 0.5 } });
  assert.equal(eff.image.rotate, MODEL.image.rotate, 'rotate kept its default');
  assert.equal(eff.image.quality, 0.5);
});

test('identity fields are carried through untouched', () => {
  const eff = applyModelOverrides(MODEL, { image: { rotate: 90 } });
  assert.equal(eff.id, MODEL.id);
  assert.equal(eff.driverKind, MODEL.driverKind);
  assert.equal(eff.usbVendorId, MODEL.usbVendorId);
  assert.deepEqual(eff.usbProductIds, MODEL.usbProductIds);
  assert.equal(eff.keyCount, MODEL.keyCount);
});

test('wire settings remain model-owned through overrides', () => {
  assert.equal(MK2_MODEL.wire.packetSize, 1024);
  assert.equal(
    applyModelOverrides(MK2_MODEL, { image: { rotate: 90 } }).wire.packetSize,
    MK2_MODEL.wire.packetSize,
  );
  assert.equal(applyModelOverrides(MK2_MODEL, { wire: { packetSize: 512 } }).wire.packetSize, 512);
});

test('a splash override replaces the model splash wholesale', () => {
  const eff = applyModelOverrides(MODEL, { splash: { transformOverride: { rotate: 90 } } });
  assert.deepEqual(eff.splash, { transformOverride: { rotate: 90 } });
});

// overrideSummary / overrideRevision

console.log('\noverrideSummary and overrideRevision');

test('summary is "none" when there is nothing set', () => {
  assert.equal(overrideSummary(), 'none');
  assert.equal(overrideSummary({}), 'none');
});

test('summary names each tuned section and field', () => {
  const summary = overrideSummary({
    image: { rotate: 180, flipH: true },
    keyMap: { inputOffset: 1 },
  });
  assert.ok(summary.includes('image{rotate,flipH}'), summary);
  assert.ok(summary.includes('keyMap{inputOffset}'), summary);
});

test('revision is empty with no override (cache keys stay as before)', () => {
  assert.equal(overrideRevision(), '');
  assert.equal(overrideRevision({}), '');
});

test('revision changes when the image spec changes, and is stable otherwise', () => {
  const a = overrideRevision({ image: { rotate: 90 } });
  const b = overrideRevision({ image: { rotate: 180 } });
  assert.notEqual(a, b, 'a different rotation must bust the cache');
  assert.equal(a, overrideRevision({ image: { rotate: 90 } }), 'same spec → same revision');
});

// tunableDefaults

console.log('\ntunableDefaults');

test('EVERY registry model round-trips: tunableDefaults is a valid override', () => {
  // The invariant behind the Device tuning form: seed the
  // controls from the device's current spec, press Apply
  // without changing anything, and the server must accept it.
  for (const model of DEVICE_MODELS) {
    const result = validateModelOverride(tunableDefaults(model), model);
    assert.ok(result.ok, `${model.id}: ${result.ok ? '' : result.errors.join('; ')}`);
  }
});

test('the seed carries no non-tunable protocol fields', () => {
  for (const model of DEVICE_MODELS) {
    const seed = tunableDefaults(model);
    for (const excluded of ['format', 'colorMode', 'bmpPpm']) {
      assert.ok(!(excluded in (seed.image ?? {})), `${model.id}: image.${excluded} leaked`);
    }
    for (const excluded of ['sharedSerial', 'packetSizeCandidates']) {
      assert.ok(!(excluded in (seed.wire ?? {})), `${model.id}: wire.${excluded} leaked`);
    }
  }
});

test('the seed omits the sizes elgato-hid models cannot tune', () => {
  for (const model of DEVICE_MODELS.filter((m) => m.driverKind === 'elgato-hid')) {
    const wire = tunableDefaults(model).wire ?? {};
    assert.ok(!('packetSize' in wire), `${model.id}: wire.packetSize leaked into the seed`);
    assert.ok(!('inSize' in wire), `${model.id}: wire.inSize leaked into the seed`);
  }
  // …and a Mirabox board still gets them: the packet size is the knob an untested
  // rebadge is calibrated with (see wire.packetSizeCandidates).
  const wire = tunableDefaults(MIRABOX_293_MODEL).wire ?? {};
  assert.equal(wire.packetSize, MIRABOX_293_MODEL.wire.packetSize);
  assert.equal(wire.inSize, MIRABOX_293_MODEL.wire.inSize);
});

// wire: protocol-fixed sizes

console.log('\nvalidateModelOverride: wire sizes');

test('elgato-hid models reject packetSize/inSize overrides', () => {
  for (const key of ['packetSize', 'inSize'] as const) {
    const result = validateModelOverride({ wire: { [key]: 512 } }, MK2_MODEL);
    assert.ok(!result.ok, `wire.${key} must be rejected for an elgato-hid model`);
    assert.ok(
      !result.ok && result.errors.some((e) => e.startsWith(`wire.${key}: not tunable`)),
      `wire.${key}: expected a "not tunable" error, got ${result.ok ? '' : result.errors.join('; ')}`,
    );
  }
});

test('mirabox models still accept a packetSize override', () => {
  const result = validateModelOverride({ wire: { packetSize: 512 } }, MIRABOX_293_MODEL);
  assert.ok(result.ok, 'the packet size is the calibration knob for a Mirabox board');
});

// An unbounded inSize is allocated as a read buffer on the USB worker thread.
test('inSize is bounded on both sides', () => {
  const tooBig = validateModelOverride({ wire: { inSize: 2_000_000_000 } }, MIRABOX_293_MODEL);
  assert.ok(!tooBig.ok, 'a 2 GB read buffer must be rejected');
  const tooSmall = validateModelOverride({ wire: { inSize: 0 } }, MIRABOX_293_MODEL);
  assert.ok(!tooSmall.ok, 'a zero-length read buffer must be rejected');
  const ok = validateModelOverride({ wire: { inSize: 1024 } }, MIRABOX_293_MODEL);
  assert.ok(ok.ok, 'a plausible read buffer must still be accepted');
});

test('seeds from the model and validates against it', () => {
  const defaults = tunableDefaults(MODEL);
  assert.equal(defaults.image?.rotate, MODEL.image.rotate);
  assert.equal(defaults.image?.width, MODEL.image.width);
  assert.deepEqual(errorsFor(defaults), [], 'the UI seed is itself a valid override');
});

test('round-trips: applying the defaults yields the same effective spec', () => {
  const eff = applyModelOverrides(MODEL, tunableDefaults(MODEL));
  assert.deepEqual(eff.image, MODEL.image);
  assert.deepEqual(eff.keyMap, MODEL.keyMap);
});

// classifyOverrideChange

console.log('\nclassifyOverrideChange');

test('an unchanged override needs no device work', () => {
  assert.equal(classifyOverrideChange(undefined, undefined), 'none');
  assert.equal(classifyOverrideChange({}, undefined), 'none');
  assert.equal(classifyOverrideChange({ image: {} }, {}), 'none');
  assert.equal(
    classifyOverrideChange(
      { image: { rotate: 90, quality: 0.8 } },
      { image: { quality: 0.8, rotate: 90 } },
    ),
    'none',
    'key order is not a change',
  );
  assert.equal(
    classifyOverrideChange(
      { image: { rotate: 90 } },
      { image: { rotate: 90, quality: undefined } },
    ),
    'none',
    'an undefined value is the same as an absent one',
  );
});

test('an image-only change applies live', () => {
  assert.equal(classifyOverrideChange(undefined, { image: { rotate: 180 } }), 'live');
  assert.equal(classifyOverrideChange({ image: { rotate: 180 } }, undefined), 'live');
  assert.equal(
    classifyOverrideChange({ image: { rotate: 180, quality: 0.5 } }, { image: { rotate: 180 } }),
    'live',
    'clearing one image field is still live',
  );
  assert.equal(
    classifyOverrideChange(
      { image: { rotate: 90 }, wire: { chunkDelayMs: 2 } },
      { image: { rotate: 270 }, wire: { chunkDelayMs: 2 } },
    ),
    'live',
    'an untouched wire section does not force a reopen',
  );
});

// keyMap/wire/splash are read by the driver at open() (chunking, read buffer,
// input decode, first splash), so they cannot be swapped under a live session.
test('keyMap, wire or splash changes force a reopen', () => {
  assert.equal(classifyOverrideChange(undefined, { wire: { chunkDelayMs: 1 } }), 'reopen');
  assert.equal(classifyOverrideChange({ wire: { chunkDelayMs: 1 } }, {}), 'reopen');
  assert.equal(classifyOverrideChange(undefined, { keyMap: { imageOffset: 1 } }), 'reopen');
  assert.equal(
    classifyOverrideChange({ keyMap: { imageOffset: 1 } }, { keyMap: { imageOffset: 2 } }),
    'reopen',
  );
  assert.equal(classifyOverrideChange(undefined, { splash: { keys: [0] } }), 'reopen');
  assert.equal(
    classifyOverrideChange(
      { image: { rotate: 90 } },
      { image: { rotate: 0 }, wire: { reportId: 2 } },
    ),
    'reopen',
    'a mixed change reopens',
  );
});

// isModelOverridesRecord

console.log('\nisModelOverridesRecord');

test('accepts a map of model id → override', () => {
  assert.ok(isModelOverridesRecord({}));
  assert.ok(isModelOverridesRecord({ 'mirabox-293': { image: { rotate: 90 } } }));
});

test('rejects non-objects and entries with unknown sections', () => {
  assert.ok(!isModelOverridesRecord(null));
  assert.ok(!isModelOverridesRecord([]));
  assert.ok(!isModelOverridesRecord({ 'mirabox-293': 'rotate' }));
  assert.ok(!isModelOverridesRecord({ 'mirabox-293': { bogus: 1 } }));
});

// pinsImageFit

console.log('\npinsImageFit');

test('true only when tuning sets resizeMode or padFill', () => {
  assert.ok(pinsImageFit({ image: { resizeMode: 'pad' } }));
  assert.ok(pinsImageFit({ image: { padFill: 'edge' } }));
  assert.ok(!pinsImageFit({ image: { rotate: 90 } }));
  assert.ok(!pinsImageFit({}));
  assert.ok(!pinsImageFit());
});

// cora override section

console.log('\ncora override');

test('cora override validates, applies, and reopens', () => {
  // 293 natively advertises as mk2: restating that (with the mk2 PID) is valid.
  const native = { cora: { advertiseAs: 'mk2', productId: MODEL.cora.productId } };
  assert.ok(validateModelOverride(native, MODEL).ok);
  assert.ok(!validateModelOverride({ cora: { productId: -1 } }, MODEL).ok);
  assert.ok(!validateModelOverride({ cora: { bogus: 1 } }, MODEL).ok);

  const eff = applyModelOverrides(MODEL, native);
  assert.equal(eff.cora.advertiseAs, 'mk2');
  assert.equal(eff.cora.productId, MODEL.cora.productId);
  // Non-cora sections and the untouched model are preserved (no emulation selected).
  assert.equal(eff.cora.usePhysicalIdentity, MODEL.cora.usePhysicalIdentity);
  assert.equal(eff.image, MODEL.image);

  // A cora change reopens (it re-pairs the device).
  assert.equal(classifyOverrideChange(undefined, { cora: { advertiseAs: 'mk2' } }), 'reopen');
  // tunableDefaults projects the cora fields at their current values.
  assert.equal(tunableDefaults(eff).cora?.advertiseAs, 'mk2');
  assert.equal(tunableDefaults(eff).cora?.productId, MODEL.cora.productId);
});

test('cora.advertiseAs must name a target the model has a mapping for', () => {
  // Unknown id: would make advertisedModel() throw on every connect.
  const unknown = validateModelOverride({ cora: { advertiseAs: 'stream-deck-pluss' } }, MODEL);
  assert.ok(!unknown.ok && unknown.errors[0]!.includes('cora.advertiseAs'));
  // A real profile the model has no emulation for (its keyMap would scramble the panel).
  assert.ok(!validateModelOverride({ cora: { advertiseAs: 'stream-deck-plus' } }, MODEL).ok);
  assert.ok(!validateModelOverride({ cora: { advertiseAs: 'mini' } }, MODEL).ok);
  // Prototype keys never resolve as an emulation.
  assert.ok(!validateModelOverride({ cora: { advertiseAs: 'toString' } }, AJAZZ_AKP05E_MODEL).ok);
  // The AKP05E declares the Plus emulation.
  assert.ok(
    validateModelOverride({ cora: { advertiseAs: 'stream-deck-plus' } }, AJAZZ_AKP05E_MODEL).ok,
  );
  assert.deepEqual(
    emulationProfiles(AJAZZ_AKP05E_MODEL).map((p) => p.id),
    ['stream-deck-plus'],
  );
  assert.deepEqual(emulationProfiles(MODEL), []);
});

test('cora.productId must match the advertised target', () => {
  const plus = { advertiseAs: 'stream-deck-plus' };
  assert.ok(
    validateModelOverride({ cora: { ...plus, productId: ELGATO_PLUS_PID } }, AJAZZ_AKP05E_MODEL).ok,
  );
  assert.ok(
    !validateModelOverride({ cora: { ...plus, productId: ELGATO_MK2_PID } }, AJAZZ_AKP05E_MODEL).ok,
  );
  // No advertiseAs: productId pinned to the model's own.
  assert.ok(!validateModelOverride({ cora: { productId: ELGATO_PLUS_PID } }, MODEL).ok);
});

test('an emulation adopts its image + keyMap and the profile PID', () => {
  const eff = applyModelOverrides(AJAZZ_AKP05E_MODEL, {
    cora: { advertiseAs: 'stream-deck-plus' },
  });
  assert.equal(eff.cora.productId, ELGATO_PLUS_PID, 'PID derived from the profile');
  // Image transform comes from the AKP05E's Plus emulation (112×112, 180° rotation).
  assert.equal(eff.image.rotate, 180);
  assert.equal(eff.image.width, 112);
  // Key map drops the rightmost column: 8 keys, wire 5/10 input codes ignored.
  assert.deepEqual(eff.keyMap.coraToWireImage, [11, 12, 13, 14, 6, 7, 8, 9]);
  assert.deepEqual(eff.keyMap.wireInputToCora, [-1, 0, 1, 2, 3, -1, 4, 5, 6, 7, -1]);

  // An explicit user image/keyMap override still wins on top of the emulation.
  const tuned = applyModelOverrides(AJAZZ_AKP05E_MODEL, {
    cora: { advertiseAs: 'stream-deck-plus' },
    image: { rotate: 90 },
  });
  assert.equal(tuned.image.rotate, 90, 'user image override wins over the emulation default');
  assert.equal(tuned.image.width, 112, 'unset emulation fields still adopted');

  // A geometry-only target (the 293's native mk2) does NOT swap the image.
  const geo = applyModelOverrides(MODEL, { cora: { advertiseAs: 'mk2' } });
  assert.equal(geo.image, MODEL.image);
});

test('keyMap length is checked against the emulated grid', () => {
  const plus = { advertiseAs: 'stream-deck-plus' };
  const eight = [11, 12, 13, 14, 6, 7, 8, 9];
  const ten = [11, 12, 13, 14, 15, 6, 7, 8, 9, 10];
  assert.ok(
    validateModelOverride({ cora: plus, keyMap: { coraToWireImage: eight } }, AJAZZ_AKP05E_MODEL)
      .ok,
  );
  assert.ok(
    !validateModelOverride({ cora: plus, keyMap: { coraToWireImage: ten } }, AJAZZ_AKP05E_MODEL).ok,
  );
  // Native AKP05E keeps its 10-key grid.
  assert.ok(validateModelOverride({ keyMap: { coraToWireImage: ten } }, AJAZZ_AKP05E_MODEL).ok);
});

reportSummary();
