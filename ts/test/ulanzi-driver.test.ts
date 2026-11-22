import assert from 'tjs:assert';
import { UlanziDriver } from '../src/devices/ulanzi/ulanzi-driver.js';
import { ULANZI_D200_MODEL } from '../src/devices/ulanzi/ulanzi-d200.js';
import { CMD, HEADER_SIZE } from '../src/devices/ulanzi/ulanzi-protocol.js';
import { test, summaryExit } from './helpers/harness.js';

console.log('\nUlanziDriver.setSmallWindow');

interface Internals {
  device: unknown;
  hidLib: unknown;
  _writeScratch: Buffer;
  scheduler: { cancel(): void };
  flush(): void;
  sendClock(): void;
}

/** A driver whose hid_write records packets (no report-id byte), as open() would leave it. */
function rig(opened = true): { driver: UlanziDriver; writes: Buffer[]; i: Internals } {
  const driver = new UlanziDriver(ULANZI_D200_MODEL);
  const writes: Buffer[] = [];
  const i = driver as unknown as Internals;
  if (opened) {
    i.device = {};
    i._writeScratch = Buffer.alloc(ULANZI_D200_MODEL.wire.packetSize + 1);
    i.hidLib = {
      symbols: {
        hid_write: (_d: unknown, buf: Uint8Array, len: number): number => {
          writes.push(Buffer.from(buf.subarray(1)));
          return len;
        },
      },
    };
  }
  return { driver, writes, i };
}

const cmdOf = (pkt: Buffer): number | null =>
  pkt[0] === 0x7c && pkt[1] === 0x7c ? (pkt[2]! << 8) | pkt[3]! : null;
const framed = (writes: Buffer[], cmd: number): Buffer[] => writes.filter((w) => cmdOf(w) === cmd);
const fieldsOf = (pkt: Buffer): string[] => {
  const len = pkt[4]! | (pkt[5]! << 8) | (pkt[6]! << 16);
  return new TextDecoder().decode(pkt.subarray(HEADER_SIZE, HEADER_SIZE + len)).split('|');
};
/** The page ZIP is stored, so its manifest is readable as text in the packet stream. */
const pageText = (writes: Buffer[]): string => {
  const decoder = new TextDecoder();
  return writes
    .slice(writes.findIndex((w) => cmdOf(w) !== null))
    .map((w) => decoder.decode(w))
    .join('');
};

const PNG = new Uint8Array(64).fill(0x41);

test('an hour-format change sends one frame and no page', () => {
  const { driver, writes, i } = rig();
  driver.setSmallWindow(203, '12H');
  const frames = framed(writes, CMD.SMALL_WINDOW);
  assert.equal(frames.length, 1);
  const f = fieldsOf(frames[0]!);
  assert.equal(f[0], '203');
  assert.equal(f[5], '12H');
  writes.length = 0;
  i.scheduler.cancel();
  i.flush();
  assert.equal(writes.length, 0, 'nothing queued for a same-mode change');
});

test('a mode change sends one frame at once, then a full page carrying the new mode', () => {
  const { driver, writes, i } = rig();
  driver.setSmallWindow(0, '24H');
  assert.equal(framed(writes, CMD.SMALL_WINDOW).length, 1);
  assert.equal(fieldsOf(framed(writes, CMD.SMALL_WINDOW)[0]!)[0], '0');
  assert.equal(framed(writes, CMD.SET_BUTTONS).length, 0, 'the page waits for the debounce');
  writes.length = 0;
  i.scheduler.cancel();
  i.flush(); // the debounce timer's work
  assert.equal(framed(writes, CMD.SET_BUTTONS).length, 1, 'full page even with no staged image');
  assert.equal(framed(writes, CMD.PARTIAL_UPDATE).length, 0);
  assert.ok(pageText(writes).includes('"SmallViewMode":0'), 'manifest carries the mode');
});

test('a mode change rewrites every remembered key in the full page', () => {
  const { driver, writes, i } = rig();
  driver.sendImage(0, PNG);
  i.scheduler.cancel();
  i.flush();
  writes.length = 0;
  driver.setSmallWindow(1, '24H');
  i.scheduler.cancel();
  i.flush();
  assert.equal(framed(writes, CMD.SET_BUTTONS).length, 1);
  const text = pageText(writes);
  assert.ok(text.includes('"0_0"'), 'the earlier key is still in the page');
  assert.ok(text.includes('"SmallViewMode":1'));
});

test('the keepalive frame follows the stored mode and format', () => {
  const { driver, writes, i } = rig();
  driver.setSmallWindow(201, '12H');
  i.scheduler.cancel();
  writes.length = 0;
  i.sendClock();
  const f = fieldsOf(framed(writes, CMD.SMALL_WINDOW)[0]!);
  assert.equal(f[0], '201');
  assert.equal(f[5], '12H');
});

test("with no call the frame is today's: mode 203, 24H", () => {
  const { writes, i } = rig();
  i.sendClock();
  const f = fieldsOf(framed(writes, CMD.SMALL_WINDOW)[0]!);
  assert.equal(f[0], '203');
  assert.equal(f[1], '0');
  assert.equal(f[5], '24H');
  assert.equal(f[6], '');
});

test('a mode the model does not list is ignored', () => {
  const { driver, writes, i } = rig();
  driver.setSmallWindow(5, '24H');
  assert.equal(writes.length, 0);
  i.sendClock();
  assert.equal(fieldsOf(framed(writes, CMD.SMALL_WINDOW)[0]!)[0], '203');
});

test('before open the values are stored and no write is attempted', () => {
  const { driver, writes, i } = rig(false);
  driver.setSmallWindow(2, '12H');
  assert.equal(writes.length, 0);
  // open()'s handshake would now send the stored values.
  i.device = {};
  i._writeScratch = Buffer.alloc(ULANZI_D200_MODEL.wire.packetSize + 1);
  i.hidLib = {
    symbols: {
      hid_write: (_d: unknown, buf: Uint8Array, len: number): number => {
        writes.push(Buffer.from(buf.subarray(1)));
        return len;
      },
    },
  };
  i.sendClock();
  assert.equal(fieldsOf(framed(writes, CMD.SMALL_WINDOW)[0]!)[0], '2');
});

console.log('\nUlanziDriver.setHostStats');

const statsOf = (pkt: Buffer): string[] => {
  const f = fieldsOf(pkt);
  return [f[1]!, f[2]!, f[4]!]; // cpu, mem, gpu
};

test('stats are stored, not written: the next keepalive frame carries them', () => {
  const { driver, writes, i } = rig();
  driver.setHostStats(12, 34, 56);
  assert.equal(writes.length, 0, 'no extra write');
  i.sendClock();
  const frames = framed(writes, CMD.SMALL_WINDOW);
  assert.equal(frames.length, 1);
  assert.deepEqual(statsOf(frames[0]!), ['12', '34', '56']);
  i.sendClock();
  assert.deepEqual(
    statsOf(framed(writes, CMD.SMALL_WINDOW)[1]!),
    ['12', '34', '56'],
    'they persist',
  );
});

test('stats are clamped to whole percents 0-100', () => {
  const { driver, writes, i } = rig();
  driver.setHostStats(150, -4, 49.6);
  i.sendClock();
  assert.deepEqual(statsOf(framed(writes, CMD.SMALL_WINDOW)[0]!), ['100', '0', '50']);
  driver.setHostStats(Number.NaN, 1, 2);
  i.sendClock();
  assert.deepEqual(statsOf(framed(writes, CMD.SMALL_WINDOW)[1]!), ['0', '1', '2']);
});

test('stats set before open ride the handshake frame; no write, no page owed', () => {
  const { driver, writes, i } = rig(false);
  driver.setHostStats(7, 8, 9);
  assert.equal(writes.length, 0);
  i.device = {};
  i._writeScratch = Buffer.alloc(ULANZI_D200_MODEL.wire.packetSize + 1);
  i.hidLib = {
    symbols: {
      hid_write: (_d: unknown, buf: Uint8Array, len: number): number => {
        writes.push(Buffer.from(buf.subarray(1)));
        return len;
      },
    },
  };
  i.sendClock();
  assert.deepEqual(statsOf(framed(writes, CMD.SMALL_WINDOW)[0]!), ['7', '8', '9']);
  writes.length = 0;
  i.scheduler.cancel();
  i.flush();
  assert.equal(writes.length, 0, 'a stats change never queues a page');
});

test('a mode change frame carries the stored stats; the default frame has zeros', () => {
  const { driver, writes, i } = rig();
  i.sendClock();
  assert.deepEqual(statsOf(framed(writes, CMD.SMALL_WINDOW)[0]!), ['0', '0', '0'], "today's bytes");
  driver.setHostStats(21, 43, 0);
  driver.setSmallWindow(0, '24H');
  assert.deepEqual(statsOf(framed(writes, CMD.SMALL_WINDOW)[1]!), ['21', '43', '0']);
});

console.log('\nUlanziDriver slot 13 (info-window widget)');

const WIDE_PNG = new Uint8Array(96).fill(0x57);

/** Packets of the page a flush writes, as text (the ZIP is stored). */
const flushed = (writes: Buffer[], i: Internals): string => {
  writes.length = 0;
  i.scheduler.cancel();
  i.flush();
  return pageText(writes);
};

test('slot 13 takes an image only while the window shows one (mode 2)', () => {
  const { driver, writes, i } = rig();
  driver.sendImage(13, WIDE_PNG); // default mode 203: dropped
  assert.equal(flushed(writes, i), '', 'nothing staged in the firmware-drawn clock mode');
  for (const mode of [0, 1, 200, 203]) {
    driver.setSmallWindow(mode, '24H');
    driver.sendImage(13, WIDE_PNG);
    driver.clearKey(13);
  }
  assert.ok(!flushed(writes, i).includes('"Icon"'), 'no firmware mode ever stages the slot');
  driver.setSmallWindow(2, '24H');
  driver.sendImage(13, WIDE_PNG);
  const text = flushed(writes, i);
  assert.ok(text.includes('"SmallViewMode":2'));
  assert.ok(text.includes('Images/13_'), 'the image rides the page as the wide Icon');
  assert.equal(framed(writes, CMD.SET_BUTTONS).length, 1, 'a mode change is a full page');
});

test('slot 13 is never a CORA key: an image for slot 14 or a hole is dropped in mode 2 too', () => {
  const { driver, writes, i } = rig();
  driver.setSmallWindow(2, '24H');
  driver.sendImage(14, WIDE_PNG);
  driver.sendImage(-1, WIDE_PNG);
  assert.ok(!flushed(writes, i).includes('Images/'), 'only slot 13 may carry the image');
});

test('leaving mode 2 drops the remembered image from the page and entering restores it', () => {
  const { driver, writes, i } = rig();
  driver.setSmallWindow(2, '24H');
  driver.sendImage(13, WIDE_PNG);
  flushed(writes, i);
  driver.setSmallWindow(1, '24H');
  const away = flushed(writes, i);
  assert.ok(away.includes('"SmallViewMode":1') && !away.includes('Images/13_'));
  driver.setSmallWindow(2, '24H');
  assert.ok(flushed(writes, i).includes('Images/13_'), 'the full page brings the image back');
});

test('clearing the widget in mode 2 stages the black fill; the real keys are untouched', () => {
  const { driver, writes, i } = rig();
  driver.setSmallWindow(2, '24H');
  driver.sendImage(0, PNG);
  driver.clearKey(13);
  const text = flushed(writes, i);
  assert.ok(text.includes('Images/13_') && text.includes('"0_0"'));
});

const WINDOW_ICON = '"SmallViewMode":2,"ViewParam":[{"Icon"';
const count = (text: string, part: string): number => text.split(part).length - 1;
const iconPath = (text: string): string => /Images\/13_\d+_[0-9a-f]{8}\.png/.exec(text)![0];

test('a partial page in mode 2 references the window Icon without re-uploading it', () => {
  const { driver, writes, i } = rig();
  driver.setSmallWindow(2, '24H');
  driver.sendImage(13, WIDE_PNG);
  const full = flushed(writes, i);
  const path = iconPath(full);
  assert.equal(count(full, path), 3, 'the full page ships the file (manifest + local + central)');
  const fullPackets = writes.length;
  driver.sendImage(0, PNG);
  const text = flushed(writes, i);
  assert.equal(framed(writes, CMD.PARTIAL_UPDATE).length, 1);
  assert.ok(text.includes('"0_0"'));
  assert.equal(count(text, WINDOW_ICON), 1, 'the window entry keeps its Icon');
  assert.equal(count(text, path), 1, 'previous path in the manifest only, no file entry');
  assert.ok(writes.length <= fullPackets, 'no more packets than the full page');
});

test('a staged window image is uploaded in a partial page', () => {
  const { driver, writes, i } = rig();
  driver.setSmallWindow(2, '24H');
  driver.sendImage(13, WIDE_PNG);
  const old = iconPath(flushed(writes, i));
  driver.sendImage(13, new Uint8Array(96).fill(0x58));
  const text = flushed(writes, i);
  assert.equal(framed(writes, CMD.PARTIAL_UPDATE).length, 1);
  assert.ok(!text.includes(old));
  assert.equal(count(text, iconPath(text)), 3, 'new image: manifest + local + central');
});

test('a full page (restoreAll) and a mode change upload the window image again', () => {
  const { driver, writes, i } = rig();
  driver.setSmallWindow(2, '24H');
  driver.sendImage(13, WIDE_PNG);
  flushed(writes, i);
  (driver as unknown as { page: { restoreAll(): void } }).page.restoreAll();
  const full = flushed(writes, i);
  assert.equal(framed(writes, CMD.SET_BUTTONS).length, 1);
  assert.equal(count(full, iconPath(full)), 3);
  driver.setSmallWindow(1, '24H');
  flushed(writes, i);
  driver.setSmallWindow(2, '24H');
  const back = flushed(writes, i);
  assert.equal(count(back, iconPath(back)), 3, 're-entering mode 2 re-uploads');
});

test('a failed flush does not leave a reference to an Icon the panel never got', () => {
  const { driver, writes, i } = rig();
  driver.setSmallWindow(2, '24H');
  driver.sendImage(13, WIDE_PNG);
  flushed(writes, i);
  const hid = (i.hidLib as { symbols: { hid_write: unknown } }).symbols;
  const ok = hid.hid_write;
  hid.hid_write = (): number => -1;
  driver.on('error', () => {});
  driver.sendImage(0, PNG);
  flushed(writes, i);
  hid.hid_write = ok;
  const retry = flushed(writes, i);
  assert.equal(count(retry, iconPath(retry)), 3, 'the retry ships the image');
});

test('a split partial page references the window Icon in every ZIP', () => {
  const { driver, writes, i } = rig();
  driver.setSmallWindow(2, '24H');
  driver.sendImage(13, WIDE_PNG);
  const path = iconPath(flushed(writes, i));
  for (let k = 0; k < 13; k++) driver.sendImage(k, new Uint8Array(20_000).fill(0x41 + k));
  const text = flushed(writes, i);
  const zips = framed(writes, CMD.PARTIAL_UPDATE).length;
  assert.ok(zips >= 2, `split into ${zips}`);
  assert.equal(count(text, WINDOW_ICON), zips);
  assert.equal(count(text, path), zips);
});

test('outside mode 2 a partial page adds no window image', () => {
  const { driver, writes, i } = rig();
  flushed(writes, i);
  driver.sendImage(0, PNG);
  assert.ok(!flushed(writes, i).includes('Images/13_'));
});

test('the 0x0303 reply names the unit: DeviceType is kept next to the firmware', () => {
  const { driver, i } = rig();
  assert.equal(driver.deviceType, undefined);
  const parse = (i as unknown as { parseInput(d: Uint8Array): void }).parseInput.bind(driver);
  const json = '{"DeviceType":"D200X","Dversion":"5.3.1"}';
  const body = new TextEncoder().encode(json);
  const pkt = new Uint8Array(HEADER_SIZE + body.length);
  pkt.set([0x7c, 0x7c, CMD.IN_DEVICE_INFO >> 8, CMD.IN_DEVICE_INFO & 0xff, body.length & 0xff], 0);
  pkt.set(body, HEADER_SIZE);
  parse(pkt);
  assert.equal(driver.deviceType, 'D200X');
  assert.equal(driver.firmware, '5.3.1');
});

summaryExit();
