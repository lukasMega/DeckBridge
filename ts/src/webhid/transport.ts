import type { DeviceModel } from '../devices/driver.js';
import type { ReportSink } from '../devices/core/types.js';
import { findModel } from '../devices/registry.js';

export function hidFilters(models: readonly DeviceModel[]): HIDDeviceFilter[] {
  const filters: HIDDeviceFilter[] = [];
  const vendors = new Set<number>();
  for (const model of models) {
    vendors.add(model.usbVendorId);
    for (const productId of model.usbProductIds) {
      filters.push({
        vendorId: model.usbVendorId,
        productId,
        ...(model.usagePage === undefined ? {} : { usagePage: model.usagePage }),
      });
    }
  }
  for (const vendorId of vendors) filters.push({ vendorId });
  filters.push({ usagePage: 0xffa0 });
  return filters;
}

function collections(items: readonly HIDCollectionInfo[]): HIDCollectionInfo[] {
  return items.flatMap((item) => [item, ...collections(item.children)]);
}

export function reportLength(
  device: HIDDevice,
  kind: 'output' | 'feature',
  reportId: number,
): number | null {
  const all = collections(device.collections);
  const usagePage = findModel(device.vendorId, device.productId)?.usagePage;
  const selected =
    all.find((c) => usagePage !== undefined && c.usagePage === usagePage) ??
    all.find((c) => c.outputReports.length > 0);
  if (!selected) return null;
  // WebHID already aggregates nested items into each ancestor report.
  const reports = (kind === 'output' ? selected.outputReports : selected.featureReports).filter(
    (report) => report.reportId === reportId,
  );
  if (reports.length === 0) return null;
  return Math.ceil(
    reports.reduce(
      (bits, r) => bits + r.items.reduce((n, i) => n + i.reportSize * i.reportCount, 0),
      0,
    ) / 8,
  );
}

export class HidTransport {
  private queue: Promise<void> = Promise.resolve();
  private failed = false;
  private input: ((data: Uint8Array) => void) | undefined;
  private lost: (() => void) | undefined;
  private readonly hid: HID | undefined;

  constructor(
    private readonly device: HIDDevice,
    private readonly onError: (reason: 'write') => void,
    hid = typeof navigator === 'undefined' ? undefined : navigator.hid,
  ) {
    this.hid = hid;
    device.addEventListener('inputreport', this.inputReport);
    hid?.addEventListener('disconnect', this.disconnect);
  }

  private readonly inputReport = (event: HIDInputReportEvent): void => {
    const bytes = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
    if (event.reportId === 0) this.input?.(bytes);
    else {
      const framed = new Uint8Array(bytes.length + 1);
      framed[0] = event.reportId;
      framed.set(bytes, 1);
      this.input?.(framed);
    }
  };

  private readonly disconnect = (event: Event & { device: HIDDevice }): void => {
    if (event.device === this.device) this.lost?.();
  };

  private fail(): void {
    if (this.failed) return;
    this.failed = true;
    this.onError('write');
  }

  private enqueue(report: Uint8Array, kind: 'output' | 'feature'): void {
    if (this.failed) return;
    const id = report[0]!;
    const length = reportLength(this.device, kind, id);
    if (length === null || report.length - 1 > length) {
      this.fail();
      return;
    }
    // Cores reuse scratch buffers immediately after this call.
    const data = new Uint8Array(length);
    data.set(report.subarray(1));
    this.queue = this.queue
      .then(async () => {
        if (this.failed) return;
        if (kind === 'output') await this.device.sendReport(id, data);
        else await this.device.sendFeatureReport(id, data);
      })
      .catch(() => this.fail());
  }

  readonly write: ReportSink = (report) => this.enqueue(report, 'output');
  readonly sendFeature: ReportSink = (report) => this.enqueue(report, 'feature');

  onInput(fn: (data: Uint8Array) => void): void {
    this.input = fn;
  }
  onLost(fn: () => void): void {
    this.lost = fn;
  }
  flush(): Promise<void> {
    return this.queue;
  }
  dispose(): void {
    this.device.removeEventListener('inputreport', this.inputReport);
    this.hid?.removeEventListener('disconnect', this.disconnect);
    this.input = undefined;
    this.lost = undefined;
  }
}
