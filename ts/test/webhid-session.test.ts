import assert from 'tjs:assert';
import { HwSession } from '../src/webhid/hw-session.js';
import { HidTransport, reportLength } from '../src/webhid/transport.js';
import { connectHwDeck, HwDeck } from '../src/demo/hw-deck.js';
import { createTracker } from '../src/demo/track.js';
import { buildStateResponse } from '../src/demo/state.js';
import { MK2_MODEL } from '../src/devices/elgato/mk2.js';
import { MIRABOX_293_MODEL } from '../src/devices/mirabox/mirabox-293.js';
import { MIRABOX_293S_MODEL } from '../src/devices/mirabox/mirabox-293s.js';
import { AJAZZ_AKP05E_MODEL } from '../src/devices/ajazz/akp05e.js';
import { advertisedGeometry } from '../src/devices/registry.js';
import { MIRABOX_K1PRO_MODEL } from '../src/devices/mirabox/mirabox-k1pro.js';
import type { DialEvent, TouchInputEvent } from '../src/shared/types.js';
import type { DeviceModel } from '../src/devices/driver.js';
import type { DeckEvents } from '../src/demo/deck.js';
import { test, testAsync, summary } from './helpers/harness.js';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function report(id: number, length: number): HIDReportInfo {
  return { reportId: id, items: [{ reportSize: 8, reportCount: length }] };
}

class FakeDevice implements HIDDevice {
  opened = false;
  readonly vendorId: number;
  readonly productId: number;
  readonly productName = 'Session fixture';
  collections: HIDCollectionInfo[];
  readonly log: string[] = [];
  readonly outputs: Uint8Array[] = [];
  readonly features: Uint8Array[] = [];
  input: ((event: HIDInputReportEvent) => void) | undefined;
  openError: Error | undefined;
  rejectWrites = false;
  gate: Promise<void> | undefined;

  constructor(model: DeviceModel) {
    this.vendorId = model.usbVendorId;
    this.productId = model.usbProductIds[0]!;
    const elgato = model.protocol.startsWith('elgato-');
    this.collections = [
      {
        usagePage: model.usagePage ?? 0xffa0,
        children: [],
        outputReports: [
          report(
            elgato ? 2 : (model.wire.reportId ?? 0),
            elgato ? model.wire.packetSize - 1 : model.wire.packetSize,
          ),
        ],
        featureReports: [report(3, 31)],
      },
    ];
  }

  open(): Promise<void> {
    this.log.push('open');
    if (this.openError) return Promise.reject(this.openError);
    this.opened = true;
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.log.push('close');
    this.opened = false;
    return Promise.resolve();
  }
  sendReport(id: number, bytes: Uint8Array): Promise<void> {
    this.log.push(`output:${id}`);
    this.outputs.push(bytes.slice());
    return this.send();
  }
  sendFeatureReport(id: number, bytes: Uint8Array): Promise<void> {
    this.log.push(`feature:${id}`);
    this.features.push(bytes.slice());
    return this.send();
  }
  private send(): Promise<void> {
    if (!this.opened || this.rejectWrites) return Promise.reject(new Error('device unavailable'));
    return this.gate ?? Promise.resolve();
  }
  addEventListener(_type: 'inputreport', fn: (event: HIDInputReportEvent) => void): void {
    this.input = fn;
  }
  removeEventListener(): void {
    this.input = undefined;
  }
  feed(code: number, state: number): void {
    const bytes = new Uint8Array(16);
    bytes.set([0x41, 0x43, 0x4b]);
    bytes[9] = code;
    bytes[10] = state;
    this.input?.({ reportId: 0, data: new DataView(bytes.buffer) } as HIDInputReportEvent);
  }
}

class FakeHid implements HID {
  chooserCalls = 0;
  lost: ((event: Event & { device: HIDDevice }) => void) | undefined;
  constructor(
    readonly devices: HIDDevice[],
    private readonly chooserError?: Error,
  ) {}
  requestDevice(): Promise<HIDDevice[]> {
    this.chooserCalls++;
    return this.chooserError ? Promise.reject(this.chooserError) : Promise.resolve(this.devices);
  }
  addEventListener(_type: 'disconnect', fn: (event: Event & { device: HIDDevice }) => void): void {
    this.lost = fn;
  }
  removeEventListener(): void {
    this.lost = undefined;
  }
  disconnect(device: FakeDevice): void {
    device.opened = false;
    this.lost?.(Object.assign(new Event('disconnect'), { device }));
  }
}

function connection(hid: FakeHid) {
  Object.defineProperty(navigator, 'hid', { value: hid, configurable: true });
  const targets: string[] = [];
  const keys: [number, string][] = [];
  const lost: string[] = [];
  const tracker = createTracker(() => ({ trackEvent: (_event, target) => targets.push(target!) }));
  const events: DeckEvents = {
    key: (index, state) => {
      keys.push([index, state]);
    },
    dial: () => undefined,
    touch: () => undefined,
    lost: (reason) => {
      lost.push(reason);
    },
  };
  return { targets, keys, lost, tracker, events };
}

class FakeCanvas {
  static readonly state: {
    encodedPixels: Uint8ClampedArray | undefined;
    encoding: { promise: Promise<Blob>; resolve: (blob: Blob) => void } | undefined;
  } = { encodedPixels: undefined, encoding: undefined };
  readonly pixels: Uint8ClampedArray;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.pixels = new Uint8ClampedArray(width * height * 4);
  }
  getContext() {
    return {
      getImageData: () => ({ data: this.pixels }),
      putImageData: (image: { data: Uint8ClampedArray }) => {
        FakeCanvas.state.encodedPixels = image.data;
      },
    };
  }
  convertToBlob(): Promise<Blob> {
    return (
      FakeCanvas.state.encoding?.promise ??
      Promise.resolve(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])]))
    );
  }
}
Object.defineProperty(globalThis, 'OffscreenCanvas', { value: FakeCanvas, configurable: true });
Object.defineProperty(globalThis, 'ImageData', {
  value: class {
    constructor(
      readonly data: Uint8ClampedArray,
      readonly width: number,
      readonly height: number,
    ) {}
  },
  configurable: true,
});
const icon = (): OffscreenCanvas => new FakeCanvas(72, 72) as unknown as OffscreenCanvas;

function session(device: FakeDevice, model: DeviceModel): HwSession {
  return new HwSession(
    device,
    model,
    new HidTransport(device, () => undefined, new FakeHid([device])),
  );
}
function command(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes.subarray(5, 12)).split('\0')[0]!;
}

// WebHID exposes descendant items on each ancestor already.
test('real nested descriptor counts ancestor report items only once', () => {
  const device = new FakeDevice(MIRABOX_293_MODEL);
  const child = {
    usagePage: 0xffa0,
    children: [],
    outputReports: [report(0, 2)],
    featureReports: [report(3, 1)],
  };
  const parent = device.collections[0]!;
  parent.outputReports = [report(0, 6)];
  parent.featureReports = [report(3, 4)];
  parent.children = [child];
  assert.equal(reportLength(device, 'output', 0), 6);
  assert.equal(reportLength(device, 'feature', 3), 4);
});

for (const name of ['NetworkError', 'SecurityError']) {
  await testAsync(`failed open ${name} sends no shutdown writes or extra write event`, async () => {
    const device = new FakeDevice(MK2_MODEL);
    device.openError = Object.assign(new Error('open failed'), { name });
    const hid = new FakeHid([device]);
    const rig = connection(hid);
    const result = await connectHwDeck(rig.events, rig.tracker);
    const reason = name === 'SecurityError' ? 'denied' : 'open';
    assert.equal(result, { fail: reason });
    assert.equal(rig.targets, [`hw:fail:${reason}`]);
    assert.equal(device.log, ['open']);
    assert.equal(device.input, undefined);
    assert.equal(hid.lost, undefined);
  });
}

await testAsync('chooser runs synchronously and cancellation tracks nothing', async () => {
  for (const error of [
    undefined,
    Object.assign(new Error('cancelled'), { name: 'NotFoundError' }),
  ]) {
    const hid = new FakeHid([], error);
    const rig = connection(hid);
    const result = connectHwDeck(rig.events, rig.tracker);
    assert.equal(hid.chooserCalls, 1);
    assert.equal(await result, null);
    assert.equal(rig.targets, []);
  }
});

await testAsync('chooser denial stays denied', async () => {
  const hid = new FakeHid([], Object.assign(new Error('denied'), { name: 'SecurityError' }));
  const rig = connection(hid);
  assert.equal(await connectHwDeck(rig.events, rig.tracker), { fail: 'denied' });
  assert.equal(rig.targets, ['hw:fail:denied']);
});

await testAsync(
  'multi-interface chooser opens supported collection rather than first interface',
  async () => {
    const unrelated = new FakeDevice(MIRABOX_293_MODEL);
    unrelated.collections = [{ usagePage: 1, children: [], outputReports: [], featureReports: [] }];
    const supported = new FakeDevice(MIRABOX_293_MODEL);
    const rig = connection(new FakeHid([unrelated, supported]));
    const deck = await connectHwDeck(rig.events, rig.tracker);
    try {
      assert.ok(deck instanceof HwDeck);
      assert.equal(unrelated.log, []);
      assert.equal(supported.log[0], 'open');
      assert.equal(rig.targets, ['hw:mirabox-293']);
    } finally {
      if (deck instanceof HwDeck) await deck.close();
    }
  },
);

await testAsync('initial write failure tracks once and closes opened device', async () => {
  const device = new FakeDevice(MK2_MODEL);
  device.rejectWrites = true;
  const rig = connection(new FakeHid([device]));
  assert.equal(await connectHwDeck(rig.events, rig.tracker), { fail: 'write' });
  assert.equal(rig.targets, ['hw:fail:write']);
  assert.equal(device.log, ['open', 'feature:3', 'close']);
  assert.equal(device.input, undefined);
});

await testAsync('connection remains pending until init reports finish', async () => {
  const device = new FakeDevice(MK2_MODEL);
  const gate = deferred<void>();
  device.gate = gate.promise;
  const rig = connection(new FakeHid([device]));
  const pending = connectHwDeck(rig.events, rig.tracker);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(rig.targets, []);
  device.gate = undefined;
  gate.resolve();
  const deck = await pending;
  try {
    assert.equal(rig.targets, ['hw:mk2']);
  } finally {
    if (deck instanceof HwDeck) await deck.close();
  }
});

await testAsync(
  'physical disconnect tracks once and disposes without writes to closed handle',
  async () => {
    const device = new FakeDevice(MK2_MODEL);
    const hid = new FakeHid([device]);
    const rig = connection(hid);
    const deck = await connectHwDeck(rig.events, rig.tracker);
    assert.ok(deck instanceof HwDeck);
    const before = device.log.slice();
    hid.disconnect(device);
    hid.disconnect(device);
    if (deck instanceof HwDeck) await deck.close();
    assert.equal(rig.targets, ['hw:mk2', 'hw:fail:disconnect']);
    assert.equal(rig.lost, ['disconnect']);
    assert.equal(device.log, before);
    assert.equal(hid.lost, undefined);
  },
);

await testAsync('Mirabox close flushes CLE-DC and HAN before closing device', async () => {
  const device = new FakeDevice(MIRABOX_293_MODEL);
  const live = session(device, MIRABOX_293_MODEL);
  await live.open();
  device.log.length = 0;
  device.outputs.length = 0;
  await live.close();
  assert.equal(device.outputs.map(command), ['CLE', 'HAN']);
  assert.equal(Array.from(device.outputs[0]!.subarray(10, 12)), [0x44, 0x43]);
  assert.equal(device.log, ['output:0', 'output:0', 'close']);
});

await testAsync(
  'close waits for encoding but drops pending and subsequent key paints',
  async () => {
    const device = new FakeDevice(MK2_MODEL);
    const live = session(device, MK2_MODEL);
    await live.open();
    device.log.length = 0;
    const gate = deferred<Blob>();
    FakeCanvas.state.encoding = gate;
    const first = live.paint(0, icon());
    const second = live.paint(1, icon());
    await Promise.resolve();
    await Promise.resolve();
    const closed = live.close();
    await live.paint(2, icon());
    assert.equal(device.opened, true);
    assert.equal(device.outputs.length, 0);
    gate.resolve(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])]));
    try {
      await Promise.all([first, second, closed]);
    } finally {
      FakeCanvas.state.encoding = undefined;
    }
    assert.equal(device.outputs.length, 0);
    assert.equal(device.log, ['feature:3', 'close']);
  },
);

await testAsync(
  '293S physical keys map correctly and unused sixth-column keys stay ignored',
  async () => {
    const device = new FakeDevice(MIRABOX_293S_MODEL);
    const live = session(device, MIRABOX_293S_MODEL);
    const events: [number, string][] = [];
    live.onKey((index, state) => {
      events.push([index, state]);
    });
    await live.open();
    device.outputs.length = 0;
    try {
      device.feed(4, 1);
      device.feed(16, 1);
      assert.equal(events, [
        [3, 'down'],
        [3, 'up'],
      ]);
      await live.paint(3, icon());
      const bat = device.outputs.find((bytes) => command(bytes) === 'BAT')!;
      assert.equal(bat[12], 4);
    } finally {
      await live.close();
    }
  },
);

test('AKP05 status and page grid expose advertised eight-key geometry', () => {
  const state = buildStateResponse({
    model: AJAZZ_AKP05E_MODEL,
    plugged: true,
    elgatoConnected: true,
    brightness: 75,
    brightnessOverride: true,
    hardware: true,
  });
  assert.equal([state.keyCount, state.columns, state.rows], [8, 4, 2]);
  assert.equal([state.pageState.keyCount, state.pageState.columns], [8, 4]);
  assert.equal([state.docks[0]!.keyCount, state.docks[0]!.columns], [8, 4]);
});

await testAsync(
  'AKP05 advertised eight-key grid maps every visible key and excludes side keys',
  async () => {
    const device = new FakeDevice(AJAZZ_AKP05E_MODEL);
    const live = session(device, AJAZZ_AKP05E_MODEL);
    const events: [number, string][] = [];
    live.onKey((index, state) => {
      events.push([index, state]);
    });
    await live.open();
    device.outputs.length = 0;
    try {
      const geometry = advertisedGeometry(AJAZZ_AKP05E_MODEL);
      assert.equal([geometry.keyCount, geometry.columns, geometry.rows], [8, 4, 2]);
      for (const code of [1, 2, 3, 4, 6, 7, 8, 9]) device.feed(code, 1);
      device.feed(5, 1);
      device.feed(10, 1);
      assert.equal(
        events,
        Array.from({ length: 8 }, (_, index) => [index, 'down']),
      );
      for (let index = 0; index < 8; index++) await live.paint(index, icon());
      assert.equal(
        device.outputs.filter((bytes) => command(bytes) === 'BAT').map((bytes) => bytes[12]),
        [11, 12, 13, 14, 6, 7, 8, 9],
      );
    } finally {
      await live.close();
    }
  },
);

await testAsync('AKP05 forwards encoder press, rotation and strip touch input', async () => {
  const device = new FakeDevice(AJAZZ_AKP05E_MODEL);
  const live = session(device, AJAZZ_AKP05E_MODEL);
  const dials: DialEvent[] = [];
  const touches: TouchInputEvent[] = [];
  live.onDial((event) => {
    dials.push(event);
  });
  live.onTouch((event) => {
    touches.push(event);
  });
  await live.open();
  try {
    device.feed(0x35, 1);
    device.feed(0x35, 0);
    device.feed(0x50, 0);
    device.feed(0x51, 0);
    device.feed(0x42, 0);
    device.feed(0x38, 0);
    device.feed(0x39, 0);
    assert.equal(dials, [
      { index: 1, kind: 'press', state: 'down' },
      { index: 1, kind: 'press', state: 'up' },
      { index: 1, kind: 'rotate', delta: -1 },
      { index: 1, kind: 'rotate', delta: 1 },
    ]);
    assert.equal(touches, [
      { type: 'tap', x: 500, y: 50 },
      { type: 'swipe', x: 750, y: 50, endX: 50, endY: 50 },
      { type: 'swipe', x: 50, y: 50, endX: 750, endY: 50 },
    ]);
  } finally {
    await live.close();
  }
});

await testAsync('upright demo key artwork uses splash orientation overrides', async () => {
  for (const [model, expectedCorner] of [
    [MK2_MODEL, 4],
    [MIRABOX_293_MODEL, 4],
    [MIRABOX_293S_MODEL, 2],
    [MIRABOX_K1PRO_MODEL, 3],
  ] as const) {
    const device = new FakeDevice(model);
    const live = session(device, model);
    const canvas = new FakeCanvas(model.keyWidth, model.keyHeight);
    const { width, height } = canvas;
    canvas.pixels[0] = 1;
    canvas.pixels[(width - 1) * 4] = 2;
    canvas.pixels[(height - 1) * width * 4] = 3;
    canvas.pixels[(width * height - 1) * 4] = 4;
    FakeCanvas.state.encodedPixels = undefined;
    await live.open();
    try {
      await live.paint(0, canvas as unknown as OffscreenCanvas);
      assert.equal(FakeCanvas.state.encodedPixels![0], expectedCorner, model.id);
    } finally {
      await live.close();
    }
  }
});

await testAsync(
  'K1 report4 descriptor accepts init, multichunk image and shutdown at 1023 bytes',
  async () => {
    const device = new FakeDevice(MIRABOX_K1PRO_MODEL);
    device.collections[0]!.outputReports = [report(4, 1023)];
    const errors: string[] = [];
    const transport = new HidTransport(
      device,
      (reason) => {
        errors.push(reason);
      },
      new FakeHid([device]),
    );
    const live = new HwSession(device, MIRABOX_K1PRO_MODEL, transport);
    const jpeg = new Uint8Array(2500).fill(0x77);
    jpeg.set([0xff, 0xd8]);
    jpeg.set([0xff, 0xd9], jpeg.length - 2);
    FakeCanvas.state.encoding = {
      promise: Promise.resolve(new Blob([jpeg])),
      resolve: () => undefined,
    };
    try {
      await live.open();
      assert.equal(device.outputs.map(command), ['DIS', 'LIG', 'CLE', 'STP']);
      device.outputs.length = 0;
      device.log.length = 0;
      await live.paint(0, icon());
      const bat = device.outputs[0]!;
      assert.equal(command(bat), 'BAT');
      assert.equal((bat[10]! << 8) | bat[11]!, 2502);
      assert.equal(bat[12], 5);
      const chunks = device.outputs.slice(1, -1);
      assert.equal(chunks.length, 3);
      assert.ok(chunks.every((bytes) => bytes.length === 1023));
      const reassembled = Buffer.concat(chunks);
      assert.equal(Array.from(reassembled.subarray(0, jpeg.length)), Array.from(jpeg));
      assert.ok(reassembled.subarray(jpeg.length).every((byte) => byte === 0));
      assert.equal(command(device.outputs.at(-1)!), 'STP');
      await live.close();
      assert.equal(device.outputs.slice(-2).map(command), ['CLE', 'HAN']);
      assert.equal(device.log.at(-1), 'close');
      assert.ok(device.outputs.every((bytes) => bytes.length === 1023));
      assert.equal(errors, []);
    } finally {
      FakeCanvas.state.encoding = undefined;
      await live.close();
    }
  },
);

summary();
