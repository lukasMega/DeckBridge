import assert from 'tjs:assert';
import { HidTransport, hidFilters, reportLength } from '../src/webhid/transport.js';
import { DEFAULT_MODEL } from '../src/devices/registry.js';
import { test, testAsync, summary } from './helpers/harness.js';

function collection(id: number, length: number): HIDCollectionInfo {
  return {
    usagePage: 0xffa0,
    children: [],
    outputReports: [{ reportId: id, items: [{ reportSize: 8, reportCount: length }] }],
    featureReports: [{ reportId: 5, items: [{ reportSize: 8, reportCount: 4 }] }],
  };
}
class FakeDevice implements HIDDevice {
  opened = true;
  vendorId = 0x0300;
  productId = 0x3004;
  productName = 'Test deck';
  collections = [collection(2, 4), collection(0, 4)];
  writes: { kind: string; id: number; data: number[] }[] = [];
  input: ((event: HIDInputReportEvent) => void) | undefined;
  reject = false;
  open(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.opened = false;
    return Promise.resolve();
  }
  sendReport(id: number, data: Uint8Array): Promise<void> {
    this.writes.push({ kind: 'output', id, data: Array.from(data) });
    return this.reject ? Promise.reject(new Error('write failed')) : Promise.resolve();
  }
  sendFeatureReport(id: number, data: Uint8Array): Promise<void> {
    this.writes.push({ kind: 'feature', id, data: Array.from(data) });
    return Promise.resolve();
  }
  addEventListener(_type: 'inputreport', fn: (event: HIDInputReportEvent) => void): void {
    this.input = fn;
  }
  removeEventListener(): void {
    this.input = undefined;
  }
}

await testAsync('padding, report-ID splitting, copied scratch and queue order', async () => {
  const device = new FakeDevice();
  const errors: string[] = [];
  const transport = new HidTransport(device, (reason) => errors.push(reason));
  const scratch = new Uint8Array([2, 1, 2]);
  transport.write(scratch);
  scratch[1] = 9;
  transport.write(scratch);
  transport.sendFeature(new Uint8Array([5, 3]));
  await transport.flush();
  assert.equal(device.writes, [
    { kind: 'output', id: 2, data: [1, 2, 0, 0] },
    { kind: 'output', id: 2, data: [9, 2, 0, 0] },
    { kind: 'feature', id: 5, data: [3, 0, 0, 0] },
  ]);
  assert.equal(errors, []);
  transport.dispose();
});
await testAsync('oversize payload reports one failure and drops writes', async () => {
  const device = new FakeDevice();
  const errors: string[] = [];
  const transport = new HidTransport(device, (reason) => errors.push(reason));
  transport.write(new Uint8Array([2, 1, 2, 3, 4, 5]));
  transport.write(new Uint8Array([2, 1]));
  await transport.flush();
  assert.equal(errors, ['write']);
  assert.equal(device.writes, []);
  transport.dispose();
});
await testAsync('send rejection is handled once without leaking rejection', async () => {
  const device = new FakeDevice();
  device.reject = true;
  const errors: string[] = [];
  const transport = new HidTransport(device, (reason) => errors.push(reason));
  transport.write(new Uint8Array([2, 1]));
  transport.write(new Uint8Array([2, 2]));
  await transport.flush();
  assert.equal(errors, ['write']);
  assert.equal(device.writes.length, 1);
  transport.dispose();
});
test('input framing preserves DataView bounds and zero report ID', () => {
  const device = new FakeDevice();
  const transport = new HidTransport(device, () => undefined);
  const inputs: number[][] = [];
  transport.onInput((bytes) => inputs.push(Array.from(bytes)));
  const data = new DataView(new Uint8Array([99, 10, 20, 99]).buffer, 1, 2);
  device.input!({ reportId: 0, data } as HIDInputReportEvent);
  device.input!({ reportId: 2, data } as HIDInputReportEvent);
  assert.equal(inputs, [
    [10, 20],
    [2, 10, 20],
  ]);
  transport.dispose();
  assert.equal(device.input, undefined);
});
test('report lengths use matching usage page without double-counting children', () => {
  const device = new FakeDevice();
  const root = collection(0, 4);
  root.children = [collection(0, 2)];
  device.collections = [{ ...collection(0, 9), usagePage: 1 }, root];
  assert.equal(reportLength(device, 'output', 0), 4);
  assert.equal(reportLength(device, 'output', 2), null);
});
test('picker includes exact models, vendors and unknown deck usage page', () => {
  const filters = hidFilters([DEFAULT_MODEL]);
  assert.ok(
    filters.some(
      (filter) =>
        filter.vendorId === DEFAULT_MODEL.usbVendorId &&
        filter.productId === DEFAULT_MODEL.usbProductIds[0],
    ),
  );
  assert.ok(
    filters.some(
      (filter) => filter.vendorId === DEFAULT_MODEL.usbVendorId && filter.productId === undefined,
    ),
  );
  assert.ok(filters.some((filter) => filter.usagePage === 0xffa0));
});
summary();
