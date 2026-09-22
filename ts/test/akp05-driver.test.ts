import assert from 'tjs:assert';
import { Akp05Driver } from '../src/devices/ajazz/akp05-driver.js';
import { AJAZZ_AKP05E_MODEL } from '../src/devices/ajazz/akp05e.js';
import type { DialEvent, KeyEvent, TouchInputEvent } from '../src/types.js';
import { test, summaryExit } from './helpers/harness.js';

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

test('encoder press codes map left-to-right, down only (no release report)', () => {
  const d = new TestDriver();
  // hardware-verified press codes: 0x37 / 0x35 / 0x33 / 0x36.
  for (const code of [0x37, 0x35, 0x33, 0x36]) {
    d.feed(code, 0x01);
  }
  assert.deepEqual(
    d.dials,
    [0, 1, 2, 3].map((index) => ({ index, kind: 'press', state: 'down' })),
  );
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

summaryExit();
