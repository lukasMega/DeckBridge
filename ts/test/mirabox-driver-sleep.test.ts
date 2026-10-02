import assert from 'tjs:assert';
import { MiraboxDriver } from '../src/devices/mirabox/driver.js';
import { MIRABOX_293_MODEL } from '../src/devices/mirabox/mirabox-293.js';
import { CMD_DIS, CMD_HAN } from '../src/devices/mirabox/protocol.js';
import type { DeviceModel } from '../src/devices/driver.js';
import { test, summary } from './helpers/harness.js';

console.log('\nMiraboxDriver.setSleep');

interface Internals {
  device: unknown;
  hidLib: unknown;
  _writeScratch: Buffer;
  reportId: number;
}

/** A driver whose hid_write records packets (no report-id byte), as open() would leave it. */
function rig(model: DeviceModel): { driver: MiraboxDriver; writes: Buffer[] } {
  const driver = new MiraboxDriver(model);
  const writes: Buffer[] = [];
  const i = driver as unknown as Internals;
  i.device = {};
  i._writeScratch = Buffer.alloc(model.wire.packetSize + 1);
  i.reportId = 0;
  i.hidLib = {
    symbols: {
      hid_write: (_d: unknown, buf: Uint8Array, len: number): number => {
        writes.push(Buffer.from(buf.subarray(1)));
        return len;
      },
    },
  };
  return { driver, writes };
}

const tag = (pkt: Buffer): string => String.fromCharCode(...pkt.subarray(5, 8));
const HAN = String.fromCharCode(...CMD_HAN);
const DIS = String.fromCharCode(...CMD_DIS);

test('sleep model: HAN on sleep, DIS + LIG(last level) on wake', () => {
  const { driver, writes } = rig({ ...MIRABOX_293_MODEL, sleep: 'mirabox-han' });
  driver.setBrightness(40);
  writes.length = 0;
  driver.setSleep(true);
  assert.deepEqual(writes.map(tag), [HAN]);
  driver.setSleep(true);
  assert.equal(writes.length, 1, 'repeat is ignored');
  driver.setSleep(false);
  assert.deepEqual(writes.map(tag), [HAN, DIS, 'LIG']);
  assert.equal(writes[2]![10], 40, 'wake restores the last brightness level');
});

test('after a reinit wakes the panel, a forced setSleep(true) sends HAN again', () => {
  const { driver, writes } = rig({ ...MIRABOX_293_MODEL, sleep: 'mirabox-han' });
  driver.setSleep(true);
  (driver as unknown as { _writeInitSequence(): void })._writeInitSequence();
  writes.length = 0;
  driver.setSleep(true);
  assert.deepEqual(writes.map(tag), [HAN]);
});

test('model without sleep ignores the call', () => {
  const { driver, writes } = rig({ ...MIRABOX_293_MODEL });
  driver.setSleep(true);
  driver.setSleep(false);
  assert.equal(writes.length, 0);
});

summary();
