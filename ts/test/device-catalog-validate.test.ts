import assert from 'tjs:assert';
import { CORA_PROFILES, DEVICE_MODELS, findModelById } from '../src/devices/registry.js';
import type { DeviceModel } from '../src/devices/driver.js';
import { PROTOCOL_STRATEGY } from '../src/devices/protocol/index.js';
import { validateCatalog } from '../src/devices/validate-model.js';
import { test, summaryExit } from './helpers/harness.js';

const real = (id: string): DeviceModel => findModelById(id)!;
const MK2 = real('mk2');
const MINI = real('mini');
const M293 = real('mirabox-293');
const S293 = real('mirabox-293s');
const D6 = real('fifine-d6');
const AKP05E = real('ajazz-akp05e');
const EMU = AKP05E.cora.emulations!['stream-deck-plus']!;
const WIDGET = AKP05E.widgetDisplays![0]!;

/** Errors from the real catalog with `bad` added (replacing the model with the same id). */
function errorsWith(bad: DeviceModel, ...extra: DeviceModel[]): string[] {
  const models = DEVICE_MODELS.filter((m) => m.id !== bad.id);
  return validateCatalog([...models, bad, ...extra], CORA_PROFILES);
}

function withStrategies(s: object): string[] {
  return validateCatalog([MK2, MINI], CORA_PROFILES, s);
}

function withImage(patch: object): DeviceModel {
  return { ...MK2, image: { ...MK2.image, ...patch } };
}

function assertNames(errors: string[], ...needles: string[]): void {
  assert.ok(errors.length > 0, 'expected at least one error');
  assert.ok(
    errors.some((e) => needles.every((n) => e.includes(n))),
    `no error naming ${needles.join(' + ')} in:\n${errors.join('\n')}`,
  );
}

console.log('\ndevice-catalog-validate: real catalog');

test('the real catalog validates clean', () => {
  assert.deepEqual(validateCatalog(DEVICE_MODELS, CORA_PROFILES), []);
});

console.log('\ndevice-catalog-validate: one failing fixture per check');

test('1 duplicate model id names both models, including a profile clash', () => {
  const dup = { ...MINI, id: 'mk2', name: 'Imposter' };
  const errors = validateCatalog([MK2, dup], CORA_PROFILES);
  assertNames(errors, 'mk2', MK2.name, 'Imposter');
  const clash = { ...MINI, id: 'stream-deck-plus', name: 'Profile clash' };
  assertNames(errorsWith(clash), 'stream-deck-plus', 'Profile clash');
});

test('2 VID/PID outside 0..0xffff or non-integer', () => {
  assertNames(errorsWith({ ...MK2, usbVendorId: 0x1_0000 }), 'mk2', 'usbVendorId');
  assertNames(errorsWith({ ...MK2, usbProductIds: [0x80, -1] }), 'mk2', 'usbProductIds');
  assertNames(errorsWith({ ...MK2, usbProductIds: [1.5] }), 'mk2', 'usbProductIds');
});

test('3 VID/PID pair in two models names both', () => {
  const clash = { ...MINI, usbVendorId: MK2.usbVendorId, usbProductIds: [0x0080] };
  assertNames(errorsWith(clash), 'mini', 'mk2', '0x0fd9:0x0080');
});

test('4 unknown protocol', () => {
  const bad = { ...MK2, protocol: 'nope' } as unknown as DeviceModel;
  assertNames(errorsWith(bad), 'mk2', "unknown protocol 'nope'");
});

test('5 strategy-backed protocol without a complete PROTOCOL_STRATEGY entry', () => {
  const gen2 = PROTOCOL_STRATEGY['elgato-gen2']!;
  const gen2Missing = { ...PROTOCOL_STRATEGY, 'elgato-gen2': { ...gen2, resetReport: undefined } };
  const noEntry = { 'elgato-gen1': PROTOCOL_STRATEGY['elgato-gen1'] };
  assertNames(withStrategies(gen2Missing), 'mk2', 'resetReport');
  assertNames(withStrategies(noEntry), 'mk2', 'no PROTOCOL_STRATEGY entry');
  // Protocol-level: flagged in PROTOCOLS but unused by any model, so no model id to name.
  assertNames(
    validateCatalog([], [], noEntry),
    "protocol 'elgato-gen2'",
    'strategy: true',
    'PROTOCOL_STRATEGY',
  );
  const badInfo = { ...gen2, infoReports: { serial: gen2.infoReports.serial } };
  assertNames(
    withStrategies({ ...PROTOCOL_STRATEGY, 'elgato-gen2': badInfo }),
    'mk2',
    'infoReports',
  );
});

test('6 keyCount vs rows*columns, image map length, input targets', () => {
  assertNames(errorsWith({ ...MK2, keyCount: 14 }), 'mk2', 'keyCount 14');
  const shortMap = { ...M293, keyMap: { ...M293.keyMap, coraToWireImage: [0, 1, 2] } };
  assertNames(errorsWith(shortMap), 'mirabox-293', 'coraToWireImage has 3');
  const oob = { ...S293, keyMap: { ...S293.keyMap, wireInputToCora: [0, 15] } };
  assertNames(errorsWith(oob), 'mirabox-293s', 'wireInputToCora target 15');
});

test('7 advertiseAs resolves, emulation keys are profiles, no cycles', () => {
  const missing = { ...M293, cora: { ...M293.cora, advertiseAs: 'ghost' } };
  assertNames(errorsWith(missing), 'mirabox-293', "'ghost'");
  const emu = {
    ...AKP05E,
    cora: { ...AKP05E.cora, emulations: { mk2: EMU } },
  };
  assertNames(errorsWith(emu), 'ajazz-akp05e', "emulations key 'mk2'");
  const self = { ...M293, cora: { ...M293.cora, advertiseAs: 'mirabox-293' } };
  assertNames(errorsWith(self), 'mirabox-293', 'cycle');
  const loopA = { ...MINI, cora: { ...MINI.cora, advertiseAs: 'mk2' } };
  const loopB = { ...MK2, cora: { ...MK2.cora, advertiseAs: 'mini' } };
  const swap = (m: DeviceModel): DeviceModel => {
    if (m.id === 'mini') return loopA;
    return m.id === 'mk2' ? loopB : m;
  };
  const errors = validateCatalog(DEVICE_MODELS.map(swap), CORA_PROFILES);
  assertNames(errors, 'mini', 'cycle');
});

test('8 cora.productId must be a PID of the advertised model', () => {
  const bad = { ...AKP05E, cora: { ...AKP05E.cora, productId: 0x0080 } };
  assertNames(errorsWith(bad), 'ajazz-akp05e', '0x0080', 'stream-deck-plus');
  assertNames(errorsWith({ ...MK2, cora: { ...MK2.cora, productId: 0x1234 } }), 'mk2', '0x1234');
  assertNames(
    errorsWith({ ...MK2, cora: { ...MK2.cora, productId: 0x10000 } }),
    'mk2',
    'productId',
  );
});

test('9 emulation keyMap must fit the emulated profile grid', () => {
  const badInput = {
    ...AKP05E,
    cora: {
      ...AKP05E.cora,
      emulations: {
        'stream-deck-plus': { ...EMU, keyMap: { ...EMU.keyMap, wireInputToCora: [-1, 8] } },
      },
    },
  };
  assertNames(errorsWith(badInput), 'ajazz-akp05e', "emulations['stream-deck-plus']", 'target 8');
  const badImage = {
    ...AKP05E,
    cora: {
      ...AKP05E.cora,
      emulations: {
        'stream-deck-plus': { ...EMU, keyMap: { ...EMU.keyMap, coraToWireImage: [1, 2, 3] } },
      },
    },
  };
  assertNames(errorsWith(badImage), 'ajazz-akp05e', 'coraToWireImage has 3');
  // Extra-key switch 1 also drives CORA key 0 here.
  const overlap = { ...AKP05E, keyMap: { ...AKP05E.keyMap, extraKeyInputs: [1, 10] } };
  assertNames(errorsWith(overlap), 'ajazz-akp05e', 'also maps to a CORA key');
});

test('10 extraKeyInputs and extraKeys lengths agree', () => {
  const bad = { ...AKP05E, keyMap: { ...AKP05E.keyMap, extraKeyInputs: [5] } };
  assertNames(errorsWith(bad), 'ajazz-akp05e', 'extraKeyInputs has 1');
});

test('11 image width/height/maxBytes/quality, incl. nested specs', () => {
  assertNames(errorsWith(withImage({ width: 0 })), 'mk2', 'image.width');
  assertNames(errorsWith(withImage({ height: -4 })), 'mk2', 'image.height');
  assertNames(errorsWith(withImage({ maxBytes: -1 })), 'mk2', 'maxBytes');
  assertNames(errorsWith(withImage({ quality: 0 })), 'mk2', 'quality');
  assertNames(errorsWith(withImage({ quality: 1.5 })), 'mk2', 'quality');
  const widget = {
    ...AKP05E,
    widgetDisplays: [{ ...WIDGET, image: { ...WIDGET.image, width: 0 } }],
  };
  assertNames(errorsWith(widget), 'ajazz-akp05e', 'widgetDisplays[wireId 1].image.width');
  // BMP never encodes JPEG, so the Mini's quality 0 is valid.
  assert.equal(MINI.image.quality, 0);
  assert.deepEqual(validateCatalog([MINI], []), []);
});

test('12 batchImageTransfers only where the protocol allows it', () => {
  const bad = { ...M293, wire: { ...M293.wire, batchImageTransfers: true } };
  assertNames(errorsWith(bad), 'mirabox-293', 'batchImageTransfers');
  assert.deepEqual(validateCatalog([S293, MK2], []), []);
});

test('13 packetSizeCandidates include packetSize', () => {
  const bad = { ...D6, wire: { ...D6.wire, packetSize: 2048 } };
  assertNames(errorsWith(bad), 'fifine-d6', 'packetSizeCandidates');
});

test('14 vendor is a nonempty kebab-case slug', () => {
  for (const vendor of ['', 'Mirabox', 'mad_dog', '-x', 'a--b']) {
    assertNames(errorsWith({ ...MK2, vendor }), 'mk2', 'vendor');
  }
  assert.deepEqual(validateCatalog([{ ...MK2, vendor: 'mars-gaming' }], []), []);
});

test('15 Mirabox protocols need wire.heartbeatMs > 0', () => {
  const noBeat = { ...M293.wire };
  delete noBeat.heartbeatMs;
  assertNames(errorsWith({ ...M293, wire: noBeat }), 'mirabox-293', 'heartbeatMs');
  assertNames(
    errorsWith({ ...S293, wire: { ...S293.wire, heartbeatMs: 0 } }),
    'mirabox-293s',
    'heartbeatMs',
  );
  // Elgato and AKP05 keep keepalive elsewhere (or none), so an unset value is valid.
  assert.equal(MK2.wire.heartbeatMs, undefined);
  assert.deepEqual(validateCatalog([MK2], []), []);
});

summaryExit();
