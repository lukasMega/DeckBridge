import assert from 'tjs:assert';
import { CORA_PROFILES, DEVICE_MODELS, findModel, findModelById } from '../src/devices/registry.js';
import { imageBatchingEnabled, type DeviceModel } from '../src/devices/driver.js';
import { BROWSER_DECK_MK2_MODEL } from '../src/devices/virtual/browser-deck-profiles.js';
import { test, summaryExit } from './helpers/harness.js';

// Hand-written literals on purpose: a baseline computed from the registry could not catch
// a registry change. A deliberate device change edits the matching literal in the same commit.

// -- Shared literals -------------------------------------------------------------------

const V3_IMAGE = {
  format: 'jpeg',
  width: 112,
  height: 112,
  rotate: 0,
  flipH: false,
  flipV: false,
  maxBytes: 10240,
  transform: 'sidecar',
};
const V3_WIRE = {
  packetSize: 1024,
  inSize: 512,
  heartbeatMs: 8000,
  synthesizeKeyUp: false,
  sendStpAfterImage: true,
};
const V3_KEYMAP = {
  coraToWireImage: [11, 12, 13, 14, 15, 6, 7, 8, 9, 10, 1, 2, 3, 4, 5],
  inputOffset: 1,
};
const V3_CORA = { productId: 0x00a5, advertiseAs: 'mk2', usePhysicalIdentity: false };
const V3_GEOMETRY = { rows: 3, columns: 5, keyCount: 15, keyWidth: 112, keyHeight: 112 };
const V3_SPLASH = { transformOverride: { rotate: 180 } };

const V1_IMAGE = {
  format: 'jpeg',
  width: 85,
  height: 85,
  rotate: 90,
  flipH: false,
  flipV: false,
  maxBytes: 5120,
  transform: 'sidecar',
};
const V1_KEYMAP = {
  coraToWireImage: [13, 10, 7, 4, 1, 14, 11, 8, 5, 2, 15, 12, 9, 6, 3],
  wireInputToCora: [-1, 4, 9, 14, 3, 8, 13, 2, 7, 12, 1, 6, 11, 0, 5, 10, -1, -1, -1],
  extraKeys: [16, 17, 18],
};
const V1_CORA = V3_CORA;
const V1_GEOMETRY = { rows: 3, columns: 5, keyCount: 15, keyWidth: 85, keyHeight: 85 };
const V1_SPLASH = { transformOverride: { rotate: 270 } };
const v1Wire = (batchImageTransfers: boolean): Record<string, unknown> => ({
  packetSize: 512,
  inSize: 512,
  heartbeatMs: 8000,
  synthesizeKeyUp: true,
  sendStpAfterImage: false,
  batchImageTransfers,
  sharedSerial: true,
});

const D6_KEYMAP = V3_KEYMAP;
const d6Wire = (packetSize: number): Record<string, unknown> => ({
  packetSize,
  inSize: 512,
  heartbeatMs: 8000,
  synthesizeKeyUp: false,
  sendStpAfterImage: true,
  packetSizeCandidates: [512, 1024],
});

const AKP153E_KEYMAP = {
  coraToWireImage: [13, 10, 7, 4, 1, 14, 11, 8, 5, 2, 15, 12, 9, 6, 3],
  wireInputToCora: [-1, 4, 9, 14, 3, 8, 13, 2, 7, 12, 1, 6, 11, 0, 5, 10],
};

const AKP05_PLUS_KEYMAP = {
  coraToWireImage: [11, 12, 13, 14, 6, 7, 8, 9],
  wireInputToCora: [-1, 0, 1, 2, 3, -1, 4, 5, 6, 7, -1],
  extraKeys: [15, 10],
  extraKeyInputs: [5, 10],
};

// -- Expected catalog, in registry (probe) order ----------------------------------------

interface Expected {
  id: string;
  vendor: string;
  protocol: string;
  usbVendorId: number;
  usbProductIds: number[];
  usagePage?: number;
  usage?: number;
  geometry: Record<string, number>;
  image: Record<string, unknown>;
  wire: Record<string, unknown>;
  keyMap: Record<string, unknown>;
  cora: Record<string, unknown>;
  emulations: string[];
  splash?: Record<string, unknown>;
  batching: boolean;
  widgetDisplayIds: number[];
  touchStripId: number | null;
}

const akp05Common = {
  vendor: 'ajazz',
  protocol: 'ajazz-akp05',
  usbVendorId: 0x0300,
  usagePage: 0xffa0,
  usage: 1,
  geometry: { rows: 2, columns: 5, keyCount: 10, keyWidth: 112, keyHeight: 112 },
  image: {
    format: 'jpeg',
    width: 112,
    height: 112,
    rotate: 180,
    flipH: false,
    flipV: false,
    maxBytes: 65535,
    transform: 'sidecar',
  },
  wire: { packetSize: 1024, inSize: 512, reportId: 0 },
  keyMap: AKP05_PLUS_KEYMAP,
  cora: { productId: 0x0084, advertiseAs: 'stream-deck-plus', usePhysicalIdentity: false },
  emulations: ['stream-deck-plus'],
  splash: { transformOverride: { rotate: 180 } },
  batching: false,
  widgetDisplayIds: [1, 2, 3, 4],
  touchStripId: 1,
};

const v1Clone = (id: string, vendor: string, vid: number, pid: number): Expected => ({
  id,
  vendor,
  protocol: 'mirabox-cora-v1',
  usbVendorId: vid,
  usbProductIds: [pid],
  usagePage: 0xffa0,
  usage: 1,
  geometry: V1_GEOMETRY,
  image: V1_IMAGE,
  wire: v1Wire(false),
  keyMap: V1_KEYMAP,
  cora: V1_CORA,
  emulations: [],
  splash: V1_SPLASH,
  batching: false,
  widgetDisplayIds: [],
  touchStripId: null,
});

const v3Board = (
  id: string,
  vendor: string,
  vid: number,
  pid: number,
  overrides: Partial<Expected> = {},
): Expected => ({
  id,
  vendor,
  protocol: 'mirabox-cora',
  usbVendorId: vid,
  usbProductIds: [pid],
  usagePage: 0xffa0,
  usage: 1,
  geometry: V3_GEOMETRY,
  image: V3_IMAGE,
  wire: V3_WIRE,
  keyMap: V3_KEYMAP,
  cora: V3_CORA,
  emulations: [],
  splash: V3_SPLASH,
  batching: false,
  widgetDisplayIds: [],
  touchStripId: null,
  ...overrides,
});

const EXPECTED: Expected[] = [
  {
    id: 'mk2',
    vendor: 'elgato',
    protocol: 'elgato-gen2',
    usbVendorId: 0x0fd9,
    usbProductIds: [0x0080, 0x006d, 0x00a5],
    geometry: { rows: 3, columns: 5, keyCount: 15, keyWidth: 72, keyHeight: 72 },
    image: {
      format: 'jpeg',
      width: 72,
      height: 72,
      rotate: 0,
      flipH: false,
      flipV: false,
      maxBytes: 0,
      transform: 'passthrough',
    },
    wire: { packetSize: 1024, inSize: 512 },
    keyMap: {},
    cora: { productId: 0x0080, usePhysicalIdentity: true },
    emulations: [],
    splash: { transformOverride: { rotate: 180 } },
    batching: false,
    widgetDisplayIds: [],
    touchStripId: null,
  },
  {
    id: 'mini',
    vendor: 'elgato',
    protocol: 'elgato-gen1',
    usbVendorId: 0x0fd9,
    usbProductIds: [0x0063, 0x0090, 0x00b3, 0x00b8],
    geometry: { rows: 2, columns: 3, keyCount: 6, keyWidth: 80, keyHeight: 80 },
    image: {
      format: 'bmp',
      width: 80,
      height: 80,
      rotate: 90,
      flipH: false,
      flipV: false,
      maxBytes: 0,
      transform: 'passthrough',
    },
    wire: { packetSize: 1024, inSize: 512 },
    keyMap: {},
    cora: { productId: 0x0063, usePhysicalIdentity: true },
    emulations: [],
    splash: { transformOverride: { rotate: 90, flipH: true } },
    batching: false,
    widgetDisplayIds: [],
    touchStripId: null,
  },
  v3Board('mirabox-293', 'mirabox', 0x6603, 0x1005, {
    usbProductIds: [0x1005, 0x1006, 0x1010, 0x1014],
  }),
  {
    id: 'mirabox-293s',
    vendor: 'mirabox',
    protocol: 'mirabox-cora-v1',
    usbVendorId: 0x5548,
    usbProductIds: [0x6670],
    usagePage: 0xffa0,
    usage: 1,
    geometry: V1_GEOMETRY,
    image: V1_IMAGE,
    wire: v1Wire(true),
    keyMap: V1_KEYMAP,
    cora: V1_CORA,
    emulations: [],
    splash: V1_SPLASH,
    batching: true,
    widgetDisplayIds: [],
    touchStripId: null,
  },
  {
    id: 'mirabox-k1pro',
    vendor: 'mirabox',
    protocol: 'mirabox-cora',
    usbVendorId: 0x6603,
    usbProductIds: [0x1015, 0x1019],
    usagePage: 0xffa0,
    usage: 1,
    geometry: { rows: 2, columns: 3, keyCount: 6, keyWidth: 64, keyHeight: 64 },
    image: {
      format: 'jpeg',
      width: 64,
      height: 64,
      rotate: 0,
      flipH: true,
      flipV: false,
      maxBytes: 4096,
      transform: 'sidecar',
    },
    wire: {
      packetSize: 1024,
      inSize: 512,
      heartbeatMs: 2000,
      synthesizeKeyUp: false,
      sendStpAfterImage: true,
      reportId: 4,
      chunkPadByte: true,
    },
    keyMap: { coraToWireImage: [5, 3, 1, 6, 4, 2], wireInputToCora: [-1, 2, 5, 1, 4, 0, 3] },
    cora: { productId: 0x0063, advertiseAs: 'mini', usePhysicalIdentity: false },
    emulations: [],
    splash: { transformOverride: { rotate: 90, flipH: false } },
    batching: false,
    widgetDisplayIds: [],
    touchStripId: null,
  },
  { ...akp05Common, id: 'ajazz-akp05e', usbProductIds: [0x3004] },
  { ...akp05Common, id: 'ajazz-akp05', usbProductIds: [0x3006] },
  v3Board('ajazz-akp153e-rev2', 'ajazz', 0x0300, 0x3010, {
    geometry: { ...V3_GEOMETRY, keyWidth: 95, keyHeight: 95 },
    image: { ...V3_IMAGE, width: 95, height: 95, rotate: 90 },
    keyMap: AKP153E_KEYMAP,
  }),
  v3Board('ajazz-akp153r-rev2', 'ajazz', 0x0300, 0x3011),
  v3Board('fifine-d6', 'fifine', 0x3142, 0x0007, { wire: d6Wire(512), keyMap: D6_KEYMAP }),
  v3Board('fifine-d6-rev2', 'fifine', 0x3142, 0x0060, { wire: d6Wire(1024), keyMap: D6_KEYMAP }),
  v1Clone('ajazz-akp153', 'ajazz', 0x5548, 0x6674),
  v1Clone('ajazz-akp153e', 'ajazz', 0x0300, 0x1010),
  v1Clone('ajazz-akp153r', 'ajazz', 0x0300, 0x1020),
  v1Clone('mars-msd-one', 'mars-gaming', 0x0b00, 0x1000),
  v1Clone('maddog-gk150k', 'mad-dog', 0x0c00, 0x1000),
  v1Clone('risemode-vision-01', 'risemode', 0x0a00, 0x1001),
  v1Clone('tmice-stream-controller', 'tmice', 0x0500, 0x1001),
];

// JSON round trip drops undefined fields, so "unset" and "absent" compare equal.
function normalize(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function project(m: DeviceModel): Record<string, unknown> {
  return {
    id: m.id,
    vendor: m.vendor,
    protocol: m.protocol,
    usbVendorId: m.usbVendorId,
    usbProductIds: m.usbProductIds,
    usagePage: m.usagePage,
    usage: m.usage,
    geometry: {
      rows: m.rows,
      columns: m.columns,
      keyCount: m.keyCount,
      keyWidth: m.keyWidth,
      keyHeight: m.keyHeight,
      encoderCount: m.encoderCount,
      touchWidth: m.touchWidth,
      touchHeight: m.touchHeight,
    },
    image: {
      format: m.image.format,
      width: m.image.width,
      height: m.image.height,
      rotate: m.image.rotate,
      flipH: m.image.flipH,
      flipV: m.image.flipV,
      maxBytes: m.image.maxBytes,
      transform: m.image.transform,
    },
    wire: m.wire,
    keyMap: m.keyMap,
    cora: {
      productId: m.cora.productId,
      advertiseAs: m.cora.advertiseAs,
      usePhysicalIdentity: m.cora.usePhysicalIdentity,
    },
    emulations: Object.keys(m.cora.emulations ?? {}),
    splash: m.splash,
    batching: imageBatchingEnabled(m),
    widgetDisplayIds: (m.widgetDisplays ?? []).map((d) => d.wireId),
    touchStripId: m.touchStripDisplay?.wireId ?? null,
  };
}

// -- Tests ------------------------------------------------------------------------------

console.log('\ndevice-catalog-baseline');

test('DEVICE_MODELS order and CORA_PROFILES ids are unchanged', () => {
  assert.deepEqual(
    DEVICE_MODELS.map((m) => m.id),
    [
      'mk2',
      'mini',
      'mirabox-293',
      'mirabox-293s',
      'mirabox-k1pro',
      'ajazz-akp05e',
      'ajazz-akp05',
      'ajazz-akp153e-rev2',
      'ajazz-akp153r-rev2',
      'fifine-d6',
      'fifine-d6-rev2',
      'ajazz-akp153',
      'ajazz-akp153e',
      'ajazz-akp153r',
      'mars-msd-one',
      'maddog-gk150k',
      'risemode-vision-01',
      'tmice-stream-controller',
    ],
  );
  assert.deepEqual(
    CORA_PROFILES.map((m) => m.id),
    ['stream-deck-plus'],
  );
});

for (const expected of EXPECTED) {
  test(`${expected.id}: catalog facts are unchanged`, () => {
    const model = findModelById(expected.id);
    assert.notEqual(model, null);
    const actual = normalize(project(model!)) as Record<string, unknown>;
    const want = normalize(expected) as Record<string, unknown>;
    // Per-section compare so a failure names the section, not just the model.
    for (const section of new Set([...Object.keys(actual), ...Object.keys(want)])) {
      assert.deepEqual(actual[section], want[section], `${expected.id}.${section} changed`);
    }
  });
}

test('findModel resolves all 27 VID/PID pairs to the expected model', () => {
  const pairs: [number, number, string][] = EXPECTED.flatMap((e) =>
    e.usbProductIds.map((pid): [number, number, string] => [e.usbVendorId, pid, e.id]),
  );
  assert.equal(pairs.length, 27);
  assert.equal(new Set(pairs.map(([vid, pid]) => `${vid}:${pid}`)).size, 27);
  for (const [vid, pid, id] of pairs) {
    assert.equal(findModel(vid, pid)?.id, id, `0x${vid.toString(16)}:0x${pid.toString(16)}`);
  }
});

// Matrix rows not covered by the per-model table above:
//   MK.2 / Mini         passthrough + physical identity: table (image.transform, cora)
//   293V3               numbering + per-image commits: table (keyMap, wire.sendStpAfterImage)
//   AKP153E/R rev. 2    calibrated vs inherited geometry: table (95 vs 112)
//   AKP05 vs AKP05E     identical but for id/PID: table (shared akp05Common literal)
test('the AKP05 pair differ only by id and product id', () => {
  const [e, r] = ['ajazz-akp05e', 'ajazz-akp05'].map((id) => project(findModelById(id)!));
  assert.deepEqual(
    { ...e, id: '', usbProductIds: [] },
    { ...r, id: '', usbProductIds: [] },
    'AKP05 must stay a spread of AKP05E',
  );
});

test('the browser deck is not a USB model and has no override-able registry entry', () => {
  assert.equal(findModelById(BROWSER_DECK_MK2_MODEL.id), null);
  assert.ok(!DEVICE_MODELS.some((m) => m.id === BROWSER_DECK_MK2_MODEL.id));
  assert.deepEqual(BROWSER_DECK_MK2_MODEL.usbProductIds, []);
  assert.equal(BROWSER_DECK_MK2_MODEL.usbVendorId, 0);
});

summaryExit();
