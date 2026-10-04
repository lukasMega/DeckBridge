/**
 * The device matrix: what each mocked model must report and render.
 *
 * Hard-coded from ts/src/devices/** on purpose — the spec is the independent check, so
 * it must not import the registry it is checking. Adding a device: see e2e/README.md.
 */
export interface DeviceCase {
  /** Plan / README label. */
  label: string;
  /** Registry model id (POST /api/device-model). */
  id: string;
  /** DeviceModel.name, as the WebUI shows it. */
  name: string;
  /** Advertised CORA grid (status snapshot + key-grid preview). */
  keyCount: number;
  columns: number;
  rows: number;
  /** docks[0].extraKeys — side keys outside the grid (without any tuning override). */
  extraKeys?: readonly number[];
  /** Keys on the physical panel when an emulation advertises fewer (default: keyCount). */
  physicalKeys?: number;
  /** docks[0].pressableExtraKeys — side keys with a switch (default: none). */
  pressableExtraKeys?: readonly number[];
  /** docks[0].touchStripSize — the strip the app sees (default: none). */
  touchStripSize?: { width: number; height: number };
  /** docks[0].encoderCount — physical knobs. */
  encoderCount?: number;
  /** docks[0].widgetDisplays wire ids — touch-strip zones. */
  stripZones?: readonly number[];
  /** docks[0].coraProfile — `cora.advertiseAs` of the registry entry. */
  coraProfile?: string;
  /** CORA emulation profiles device tuning may pick (`cora.emulations`). */
  emulations?: readonly string[];
  /** Wire sizes the protocol fixes (TUNABLE_WIRE_KEYS): never offered for tuning. */
  fixedWireSizes: readonly ('packetSize' | 'inSize')[];
}

export const DEVICES: readonly DeviceCase[] = [
  {
    label: 'Ajazz AKP05E',
    id: 'ajazz-akp05e',
    name: 'AJAZZ AKP05E',
    // Pairs as a Stream Deck + by default: the Plus 4×2 grid, the right column as extra keys.
    keyCount: 8,
    columns: 4,
    rows: 2,
    physicalKeys: 10,
    extraKeys: [15, 10],
    pressableExtraKeys: [15, 10],
    touchStripSize: { width: 800, height: 100 },
    encoderCount: 4,
    stripZones: [1, 2, 3, 4],
    coraProfile: 'stream-deck-plus',
    emulations: ['stream-deck-plus'],
    fixedWireSizes: ['packetSize'],
  },
  {
    label: 'Ajazz AKP153 rev. 1',
    id: 'ajazz-akp153',
    name: 'Ajazz AKP153',
    keyCount: 15,
    columns: 5,
    rows: 3,
    extraKeys: [16, 17, 18],
    coraProfile: 'mk2',
    fixedWireSizes: [],
  },
  {
    label: 'Ajazz AKP153 rev. 2',
    id: 'ajazz-akp153e-rev2',
    name: 'Ajazz AKP153E (rev. 2)',
    keyCount: 15,
    columns: 5,
    rows: 3,
    coraProfile: 'mk2',
    fixedWireSizes: [],
  },
  {
    label: 'Mirabox 293S',
    id: 'mirabox-293s',
    name: 'Mirabox 293S Stream Deck',
    keyCount: 15,
    columns: 5,
    rows: 3,
    extraKeys: [16, 17, 18],
    coraProfile: 'mk2',
    fixedWireSizes: [],
  },
  {
    label: 'Mirabox 293V3',
    id: 'mirabox-293',
    name: 'Mirabox 293V3',
    keyCount: 15,
    columns: 5,
    rows: 3,
    coraProfile: 'mk2',
    fixedWireSizes: [],
  },
  {
    label: 'Fifine D6',
    id: 'fifine-d6',
    name: 'Fifine AmpliGame D6',
    keyCount: 15,
    columns: 5,
    rows: 3,
    coraProfile: 'mk2',
    fixedWireSizes: [],
  },
  {
    label: 'Stream Deck Mini',
    id: 'mini',
    name: 'Stream Deck Mini',
    keyCount: 6,
    columns: 3,
    rows: 2,
    fixedWireSizes: ['packetSize', 'inSize'],
  },
  {
    label: 'Stream Deck MK.2',
    id: 'mk2',
    name: 'Stream Deck MK.2',
    keyCount: 15,
    columns: 5,
    rows: 3,
    fixedWireSizes: ['packetSize', 'inSize'],
  },
];

/** The model the app boots with; every spec leaves the instance on it. */
export const DEFAULT_DEVICE = 'mk2';

/** Devices with no side keys, strip or knobs — the negative half of the matrix. */
export const PLAIN_DEVICES = DEVICES.filter(
  (d) => !d.extraKeys && !d.encoderCount && !d.stripZones,
);

/** AKP05E re-paired as a Stream Deck + (device tuning `cora.advertiseAs`). */
export const PLUS_PROFILE = {
  advertiseAs: 'stream-deck-plus',
  /** ELGATO_PLUS_PID — `cora.productId` must match the profile. */
  productId: 0x0084,
  keyCount: 8,
  columns: 4,
  rows: 2,
  /** Right column outside the Plus 4×2 grid: image wire ids, both with a switch. */
  extraKeys: [15, 10],
  touchStrip: { width: 800, height: 100 },
} as const;

export function device(id: string): DeviceCase {
  const d = DEVICES.find((x) => x.id === id);
  if (!d) throw new Error(`unknown device ${id} in the e2e matrix`);
  return d;
}
