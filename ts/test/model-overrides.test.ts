import assert from 'tjs:assert';
import {
  applyModelOverrides,
  isModelOverridesRecord,
  overrideRevision,
  overrideSummary,
  tunableDefaults,
  validateModelOverride,
} from '../src/devices/model-overrides.js';
import type { DeviceModel } from '../src/devices/driver.js';
import { DEVICE_MODELS } from '../src/devices/registry.js';
import { MIRABOX_293_MODEL } from '../src/devices/mirabox/mirabox-293.js';
import { MK2_MODEL } from '../src/devices/elgato/mk2.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

const MODEL: DeviceModel = MIRABOX_293_MODEL;

test('image batching is tunable only on 293S-family boards', () => {
  for (const model of DEVICE_MODELS) {
    const supported = model.protocol === 'mirabox-cora-v1';
    for (const batchImageTransfers of [true, false]) {
      const result = validateModelOverride({ wire: { batchImageTransfers } }, model);
      assert.equal(result.ok, supported, model.id);
    }
    assert.equal(
      tunableDefaults(model).wire?.batchImageTransfers,
      supported ? model.id === 'mirabox-293s' : undefined,
      model.id,
    );
  }
  const model = DEVICE_MODELS.find((entry) => entry.id === 'mirabox-293s')!;
  const invalid = validateModelOverride({ wire: { batchImageTransfers: 1 } }, model);
  assert.equal(invalid.ok, false);
  assert.equal(
    applyModelOverrides(model, { wire: { batchImageTransfers: false } }).wire?.batchImageTransfers,
    false,
  );
  assert.equal(model.wire?.batchImageTransfers, true, 'override never mutates registry default');
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

test('wire stays undefined for a model that has none, unless the override sets it', () => {
  // elgato-hid models keep their framing in PROTOCOL_STRATEGY, not model.wire.
  assert.equal(MK2_MODEL.wire, undefined, 'precondition: MK.2 has no wire spec');
  assert.equal(applyModelOverrides(MK2_MODEL, { image: { rotate: 90 } }).wire, undefined);
  assert.equal(
    applyModelOverrides(MK2_MODEL, { wire: { packetSize: 1024 } }).wire?.packetSize,
    1024,
  );
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
  // The invariant behind the Device tuning form: seed the controls from the
  // device's current spec, press Apply without changing anything, and the server
  // must accept it. Broken three ways at once before this test existed —
  // `image.format`/`colorMode` leaked in, `wire.sharedSerial`/
  // `packetSizeCandidates` leaked in, and the Mini's own `quality: 0` was
  // rejected. Covers models added later too.
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) tjs.exit(1);
