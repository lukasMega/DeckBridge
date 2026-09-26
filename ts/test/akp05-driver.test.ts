import assert from 'tjs:assert';
import { Akp05Driver } from '../src/devices/ajazz/akp05-driver.js';
import { AJAZZ_AKP05E_MODEL } from '../src/devices/ajazz/akp05e.js';
import { describePacket } from '../src/devices/ajazz/akp05-protocol.js';
import { transformImageForDevice } from '../src/translator.js';
import type { DialEvent, KeyEvent, TouchInputEvent } from '../src/types.js';
import { test, summaryExit } from './helpers/harness.js';
import { SOLID_RED_16X16_JPEG } from './helpers/fixtures.js';

// Input classification only — no FFI, no open(). classifyInput is reached through
// the protected parseInput, which is pure (parseAckReport + emit).

/** An ACK report carrying `code` (byte 9) and `stateByte` (byte 10). */
function ackReport(code: number, stateByte: number): Buffer {
  const buf = Buffer.alloc(16);
  buf[0] = 0x41; // 'A'
  buf[1] = 0x43; // 'C'
  buf[2] = 0x4b; // 'K'
  buf[9] = code;
  buf[10] = stateByte;
  return buf;
}

class TestDriver extends Akp05Driver {
  readonly keys: KeyEvent[] = [];
  readonly dials: DialEvent[] = [];
  readonly touches: TouchInputEvent[] = [];

  constructor() {
    super(AJAZZ_AKP05E_MODEL);
    this.on('key', (e: KeyEvent) => this.keys.push(e));
    this.on('dial', (e: DialEvent) => this.dials.push(e));
    this.on('touch', (e: TouchInputEvent) => this.touches.push(e));
  }

  feed(code: number, stateByte: number): void {
    this.parseInput(ackReport(code, stateByte));
  }
}

test('key codes 0x01–0x0a emit key events with the raw code as keyIndex', () => {
  const d = new TestDriver();
  d.feed(0x05, 0x01);
  d.feed(0x05, 0x00);
  assert.deepEqual(d.keys, [
    { keyIndex: 5, state: 'down' },
    { keyIndex: 5, state: 'up' },
  ]);
});

test('encoder press codes map left-to-right, each a down + synthesized up', () => {
  const d = new TestDriver();
  // hardware-verified press codes: 0x37 / 0x35 / 0x33 / 0x36 (no release report).
  for (const code of [0x37, 0x35, 0x33, 0x36]) {
    d.feed(code, 0x01);
  }
  assert.deepEqual(
    d.dials,
    [0, 1, 2, 3].flatMap((index) => [
      { index, kind: 'press', state: 'down' },
      { index, kind: 'press', state: 'up' },
    ]),
  );
});

test('encoder press with stateByte 0 is ignored (no double-fired pair)', () => {
  const d = new TestDriver();
  d.feed(0x37, 0x00);
  assert.deepEqual(d.dials, []);
});

test('codes just outside the key range emit nothing', () => {
  const d = new TestDriver();
  d.feed(0x00, 0x01);
  d.feed(0x0b, 0x01);
  d.feed(0x44, 0x00); // just past the tap codes
  assert.deepEqual([d.keys, d.dials, d.touches], [[], [], []]);
});

test('encoder rotate codes map [ccw, cw] per encoder with ±1 delta', () => {
  const d = new TestDriver();
  // encoder 1 (second knob) is 0x50 ccw / 0x51 cw — the codes seen in the wild.
  d.feed(0x50, 0x00); // ccw
  d.feed(0x51, 0x00); // cw
  assert.deepEqual(d.dials, [
    { index: 1, kind: 'rotate', delta: -1 },
    { index: 1, kind: 'rotate', delta: 1 },
  ]);
});

test('encoder rotate pairs are all mapped to their encoder index', () => {
  const d = new TestDriver();
  const pairs = [
    [0xa0, 0xa1],
    [0x50, 0x51],
    [0x90, 0x91],
    [0x70, 0x71],
  ] as const;
  for (let i = 0; i < pairs.length; i++) {
    d.feed(pairs[i]![0], 0); // ccw
    d.feed(pairs[i]![1], 0); // cw
  }
  assert.deepEqual(
    d.dials,
    pairs.flatMap((_, i) => [
      { index: i, kind: 'rotate', delta: -1 },
      { index: i, kind: 'rotate', delta: 1 },
    ]),
  );
});

test('touch-strip swipe codes emit touch events with synthetic coordinates', () => {
  const d = new TestDriver();
  d.feed(0x38, 0); // swipe left
  d.feed(0x39, 0); // swipe right
  assert.deepEqual(d.touches, [
    { type: 'swipe', x: 750, y: 50, endX: 50, endY: 50 },
    { type: 'swipe', x: 50, y: 50, endX: 750, endY: 50 },
  ]);
});

test('touch-strip tap codes emit taps at each zone centre, left to right', () => {
  const d = new TestDriver();
  for (const code of [0x40, 0x41, 0x42, 0x43]) d.feed(code, 0);
  assert.deepEqual(d.touches, [
    { type: 'tap', x: 100, y: 50 },
    { type: 'tap', x: 300, y: 50 },
    { type: 'tap', x: 500, y: 50 },
    { type: 'tap', x: 700, y: 50 },
  ]);
});

/** Captures every HID report instead of calling hid_write. */
class WriteCaptureDriver extends Akp05Driver {
  readonly reports: Uint8Array[] = [];

  constructor() {
    super(AJAZZ_AKP05E_MODEL);
    this.device = {};
    this.hidLib = {} as never;
  }

  protected override _writeRaw(buf: Uint8Array): number {
    this.reports.push(Uint8Array.from(buf));
    return buf.length;
  }
}

test('sendImage frames BAT → 1024-byte data chunks → ULEND, one report id byte each', () => {
  const d = new WriteCaptureDriver();
  const jpeg = new Uint8Array(1500).fill(0x77);
  d.sendImage(11, jpeg);
  const commands = d.reports.map((r) => describePacket(r.subarray(1)));
  assert.deepEqual(commands, [
    'CRT BAT jpegLen=1500 surface=11',
    'image-data chunk',
    'image-data chunk',
    'CRT ULEND',
  ]);
  for (const report of d.reports) {
    assert.equal(report.length, 1025);
    assert.equal(report[0], 0, 'report id 0');
  }
  const last = d.reports[2]!;
  assert.equal(last[1 + 475], 0x77, 'final chunk carries the last data byte');
  assert.equal(last[1 + 476], 0, 'and zero padding after it');
});

test('firmware comes from feature report 0x01 (20 B); a failed read leaves it unknown', () => {
  const read = (reply: string | null): { firmware: string | undefined; request: number[] } => {
    const request: number[] = [];
    const hid = {
      hid_get_feature_report(_device: unknown, buf: Uint8Array, len: number): number {
        request.push(buf[0]!, len);
        if (reply === null) return -1;
        buf.set(Buffer.from(reply, 'ascii'));
        return reply.length;
      },
    };
    const d = new WriteCaptureDriver() as unknown as {
      readFirmware(h: unknown): string | undefined;
    };
    return { firmware: d.readFirmware(hid), request };
  };
  assert.deepEqual(read('V3.AKP05E.02.007\0'), {
    firmware: 'V3.AKP05E.02.007',
    request: [0x01, 20],
  });
  assert.equal(read(null).firmware, undefined);
});

/** Reassemble the JPEG a single sendImage() wrote: BAT length, then the data chunks. */
function uploadedJpeg(reports: readonly Uint8Array[]): Uint8Array {
  const bat = reports[0]!.subarray(1);
  const length = (bat[10]! << 8) | bat[11]!;
  const data = reports.slice(1, -1).map((r) => r.subarray(1));
  return Buffer.concat(data).subarray(0, length);
}

/** SOF0 frame size of a baseline JPEG. */
function jpegSize(jpeg: Uint8Array): { width: number; height: number } {
  for (let i = 0; i < jpeg.length - 8; i++) {
    if (jpeg[i] === 0xff && jpeg[i + 1] === 0xc0) {
      return {
        height: (jpeg[i + 5]! << 8) | jpeg[i + 6]!,
        width: (jpeg[i + 7]! << 8) | jpeg[i + 8]!,
      };
    }
  }
  throw new Error('no SOF0 marker');
}

test('clearKey sends a decodable black JPEG sized to the slot (key 112, strip slot 176×112)', () => {
  for (const [wire, width, height] of [
    [11, 112, 112],
    [6, 112, 112],
    [1, 176, 112],
  ] as const) {
    const d = new WriteCaptureDriver();
    d.clearKey(wire);
    const jpeg = uploadedJpeg(d.reports);
    assert.deepEqual(jpegSize(jpeg), { width, height }, `wire ${wire}`);
    // Throws on a malformed stream (the old 1×1 constant had no Cb DC table).
    const decoded = transformImageForDevice(jpeg, { ...AJAZZ_AKP05E_MODEL.image, sharpen: 0 });
    assert.ok(decoded.length > 0, `wire ${wire} decodes`);
  }
});

type StripWrite = [wireId: number, jpeg: Uint8Array, full: boolean];

function captureStripWrites(d: Akp05Driver): StripWrite[] {
  const writes: StripWrite[] = [];
  d.on('stripWrite', (wireId: number, jpeg: Uint8Array, full: boolean) =>
    writes.push([wireId, jpeg, full]),
  );
  return writes;
}

const STRIP_SPEC = AJAZZ_AKP05E_MODEL.touchStripDisplay!.image;
const SLOT_SPEC = AJAZZ_AKP05E_MODEL.widgetDisplays![0]!.image;

test('sendImage emits stripWrite for strip wires only; full = full-strip width', () => {
  const d = new WriteCaptureDriver();
  const writes = captureStripWrites(d);
  const slot = transformImageForDevice(SOLID_RED_16X16_JPEG, { ...SLOT_SPEC, sharpen: 0 });
  const full = transformImageForDevice(SOLID_RED_16X16_JPEG, { ...STRIP_SPEC, sharpen: 0 });

  d.sendImage(2, slot);
  assert.deepEqual(writes, [[2, slot, false]], 'slot write on wire 2');
  writes.length = 0;
  d.sendImage(1, full);
  assert.deepEqual(writes, [[1, full, true]], '800-wide on wire 1 is a full-strip write');
  writes.length = 0;
  d.sendImage(1, slot);
  assert.deepEqual(writes, [[1, slot, false]], '176-wide on wire 1 is slot 1');
  writes.length = 0;
  d.sendImage(11, slot);
  assert.deepEqual(writes, [], 'key wire emits nothing');
  d.clearKey(3);
  assert.equal(writes.length, 1, 'clearKey on a strip wire emits once');
  assert.equal(writes[0]![0], 3);
  assert.equal(writes[0]![2], false);
});

test('a failed write emits no stripWrite', () => {
  class ThrowingDriver extends WriteCaptureDriver {
    protected override _writeRaw(): number {
      throw new Error('hid gone');
    }
  }
  const d = new ThrowingDriver();
  const writes = captureStripWrites(d);
  const errors: Error[] = [];
  d.on('error', (e: Error) => errors.push(e));
  d.sendImage(2, new Uint8Array(100));
  assert.deepEqual(writes, []);
  assert.equal(errors.length, 1, 'the failure surfaces as error instead');
});

summaryExit();
