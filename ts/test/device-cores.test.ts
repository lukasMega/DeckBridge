import assert from 'tjs:assert';
import { ElgatoCore } from '../src/devices/core/elgato-core.js';
import { MiraboxCore } from '../src/devices/core/mirabox-core.js';
import { buildCleDc } from '../src/devices/mirabox/driver.js';
import { Akp05Core } from '../src/devices/core/akp05-core.js';
import { MK2_MODEL } from '../src/devices/elgato/mk2.js';
import { MIRABOX_293_MODEL } from '../src/devices/mirabox/mirabox-293.js';
import { MIRABOX_293S_MODEL } from '../src/devices/mirabox/mirabox-293s.js';
import { AJAZZ_AKP05E_MODEL } from '../src/devices/ajazz/akp05e.js';
import { DEFAULT_BRIGHTNESS } from '../src/shared/types.js';
import { test, summary } from './helpers/harness.js';

function recording(): { reports: Uint8Array[]; write: (report: Uint8Array) => void } {
  const reports: Uint8Array[] = [];
  return {
    reports,
    write: (report) => {
      reports.push(Uint8Array.from(report));
    },
  };
}

function tag(report: Uint8Array): string {
  return String.fromCharCode(...report.subarray(6, 13)).split('\0')[0]!;
}

function ackReport(code: number, stateByte: number): Buffer {
  const report = Buffer.alloc(16);
  report.set([0x41, 0x43, 0x4b]);
  report[9] = code;
  report[10] = stateByte;
  return report;
}

function akp05(): Akp05Core {
  return new Akp05Core(AJAZZ_AKP05E_MODEL, recording().write);
}

test('Elgato init resets key edges and sends one reset feature report', () => {
  const writes = recording();
  const features = recording();
  const core = new ElgatoCore(MK2_MODEL, { write: writes.write, sendFeature: features.write });
  core.init();
  assert.equal(writes.reports.length, 0);
  assert.equal(features.reports.length, 1);
  assert.deepEqual(Array.from(features.reports[0]!.subarray(0, 2)), [3, 2]);
  const down = new Uint8Array(4 + MK2_MODEL.keyCount);
  down.set([1, 0, MK2_MODEL.keyCount, 0, 1]);
  assert.deepEqual(core.parseInput(down), [{ keyIndex: 0, state: 'down' }]);
  assert.deepEqual(core.parseInput(down), []);
  assert.deepEqual(core.parseInput(new Uint8Array([9])), []);
  const up = down.slice();
  up[4] = 0;
  assert.deepEqual(core.parseInput(up), [{ keyIndex: 0, state: 'up' }]);
  assert.deepEqual(core.parseInput(up), []);
  core.parseInput(down);
  core.init();
  assert.deepEqual(core.parseInput(down), [{ keyIndex: 0, state: 'down' }]);
});

test('Mirabox init writes DIS, default LIG, clear all and model STP', () => {
  for (const model of [MIRABOX_293_MODEL, MIRABOX_293S_MODEL]) {
    const out = recording();
    new MiraboxCore(model, out.write).init();
    assert.deepEqual(
      out.reports.map(tag),
      model.wire.sendStpAfterImage ? ['DIS', 'LIG', 'CLE', 'STP'] : ['DIS', 'LIG', 'CLE'],
    );
    assert.equal(out.reports[1]![11], DEFAULT_BRIGHTNESS);
    assert.equal(out.reports[2]![12], 255);
    assert.ok(out.reports.every((r) => r.length === model.wire.packetSize + 1));
  }
});

test('Mirabox heartbeat reinitializes after sleep and always ends with CONNECT', () => {
  const out = recording();
  const core = new MiraboxCore(MIRABOX_293_MODEL, out.write);
  const interval = MIRABOX_293_MODEL.wire.heartbeatMs!;
  core.startClock(100);
  assert.equal(core.heartbeat(100 + interval), false);
  assert.deepEqual(out.reports.map(tag), ['CONNECT']);
  out.reports.length = 0;
  assert.equal(core.heartbeat(100 + 4 * interval), true);
  assert.deepEqual(out.reports.map(tag), ['DIS', 'LIG', 'CLE', 'STP', 'CONNECT']);
});

test('Mirabox input distinguishes ACK and synthesizes v1 release', () => {
  const v1 = new MiraboxCore(MIRABOX_293S_MODEL, recording().write);
  assert.deepEqual(v1.parseInput(ackReport(7, 1)), [
    { keyIndex: 7, state: 'down' },
    { keyIndex: 7, state: 'up' },
  ]);
  assert.equal(v1.parseInput(new Uint8Array([0])), null);
  const v3 = new MiraboxCore(MIRABOX_293_MODEL, recording().write);
  assert.deepEqual(v3.parseInput(ackReport(7, 0)), [{ keyIndex: 7, state: 'up' }]);
});

test('Mirabox batch sends one STP after three images', () => {
  const out = recording();
  const core = new MiraboxCore(MIRABOX_293S_MODEL, out.write);
  core.beginBatch();
  for (let key = 1; key <= 3; key++) core.sendImage(key, new Uint8Array(600));
  assert.equal(out.reports.filter((r) => tag(r) === 'STP').length, 0);
  core.endBatch();
  assert.equal(out.reports.filter((r) => tag(r) === 'BAT').length, 3);
  assert.equal(out.reports.filter((r) => tag(r) === 'STP').length, 1);
  assert.equal(tag(out.reports.at(-1)!), 'STP');
  core.endBatch();
  assert.equal(out.reports.filter((r) => tag(r) === 'STP').length, 1);
});

test('Mirabox probed size frames commands and zeroes final image tail', () => {
  const out = recording();
  const core = new MiraboxCore(MIRABOX_293_MODEL, out.write);
  core.setPacketSize(512);
  assert.equal(core.packetSize, 512);
  assert.equal(core.reportId, 0);
  core.sendImage(3, new Uint8Array(600).fill(0x77));
  assert.ok(out.reports.every((r) => r.length === 513));
  assert.equal(out.reports[2]![88], 0x77);
  assert.equal(out.reports[2]![89], 0);
  core.reset();
  assert.equal(core.packetSize, 1024);
});

test('Mirabox close reports preserve legacy CLE-DC builder and numbered framing', () => {
  const model = { ...MIRABOX_293_MODEL, wire: { ...MIRABOX_293_MODEL.wire, reportId: 4 } };
  const core = new MiraboxCore(model, recording().write);
  const reports = core.closeReports();
  assert.deepEqual(
    Array.from(reports[0]!.subarray(1)),
    Array.from(buildCleDc(model.wire.packetSize)),
  );
  assert.equal(tag(reports[1]!), 'HAN');
  assert.ok(reports.every((report) => report[0] === 4));
  assert.deepEqual(core.parseInput(Uint8Array.from([4, ...ackReport(3, 1)])), [
    { keyIndex: 3, state: 'down' },
  ]);
});

test('AKP05 keys preserve raw codes and both states', () => {
  const core = akp05();
  assert.deepEqual(core.parseInput(ackReport(5, 1)), [
    { kind: 'key', event: { keyIndex: 5, state: 'down' } },
  ]);
  assert.deepEqual(core.parseInput(ackReport(5, 0)), [
    { kind: 'key', event: { keyIndex: 5, state: 'up' } },
  ]);
});

test('AKP05 dial presses synthesize release and ignore extra releases', () => {
  const core = akp05();
  assert.deepEqual(core.parseInput(ackReport(0x35, 1)), [
    { kind: 'dial', event: { index: 1, kind: 'press', state: 'down' } },
    { kind: 'dial', event: { index: 1, kind: 'press', state: 'up' } },
  ]);
  assert.deepEqual(core.parseInput(ackReport(0x35, 0)), []);
});

test('AKP05 rotation decodes clockwise and counterclockwise', () => {
  const core = akp05();
  assert.deepEqual(core.parseInput(ackReport(0x50, 0)), [
    { kind: 'dial', event: { index: 1, kind: 'rotate', delta: -1 } },
  ]);
  assert.deepEqual(core.parseInput(ackReport(0x51, 0)), [
    { kind: 'dial', event: { index: 1, kind: 'rotate', delta: 1 } },
  ]);
});

test('AKP05 left swipe spans full strip', () => {
  assert.deepEqual(akp05().parseInput(ackReport(0x38, 0)), [
    { kind: 'touch', event: { type: 'swipe', x: 750, y: 50, endX: 50, endY: 50 } },
  ]);
});

test('AKP05 right swipe spans full strip', () => {
  assert.deepEqual(akp05().parseInput(ackReport(0x39, 0)), [
    { kind: 'touch', event: { type: 'swipe', x: 50, y: 50, endX: 750, endY: 50 } },
  ]);
});

test('AKP05 tap targets zone centre', () => {
  assert.deepEqual(akp05().parseInput(ackReport(0x42, 0)), [
    { kind: 'touch', event: { type: 'tap', x: 500, y: 50 } },
  ]);
});

test('AKP05 distinguishes unmapped, unknown and firmware input', () => {
  const core = akp05();
  assert.deepEqual(core.parseInput(ackReport(0x44, 1)), [
    { kind: 'unmapped', code: 0x44, stateByte: 1 },
  ]);
  assert.deepEqual(core.parseInput(new Uint8Array([0])), [{ kind: 'unknown' }]);
  assert.deepEqual(core.parseInput(Buffer.from('V3.AKP05E.02.007')), [
    { kind: 'firmware', version: 'V3.AKP05E.02.007' },
  ]);
});

test('AKP05 strip uploads identify strip and frame BAT, chunks, ULEND', () => {
  const out = recording();
  const core = new Akp05Core(AJAZZ_AKP05E_MODEL, out.write);
  assert.deepEqual(core.sendImage(1, new Uint8Array(1500)), { strip: true, full: false });
  assert.deepEqual(out.reports.map(tag), ['BAT', '', '', 'ULEND']);
  assert.ok(out.reports.every((r) => r.length === 1025 && r[0] === 0));
  assert.equal(core.sendImage(11, new Uint8Array(1)).strip, false);
});

test('AKP05 init and keepalive retain current brightness', () => {
  const out = recording();
  const core = new Akp05Core(AJAZZ_AKP05E_MODEL, out.write);
  core.setBrightness(40);
  out.reports.length = 0;
  core.init();
  assert.deepEqual(out.reports.map(tag), ['VER', 'DIS', 'LIG', 'CLE', 'STP']);
  assert.equal(out.reports[2]![11], 40);
  out.reports.length = 0;
  core.keepAlive();
  assert.deepEqual(out.reports.map(tag), ['DIS', 'LIG', 'CONNECT']);
  assert.equal(out.reports[1]![11], 40);
});

summary();
