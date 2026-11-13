interface HIDDeviceFilter {
  vendorId?: number;
  productId?: number;
  usagePage?: number;
}
interface HIDReportItem {
  reportSize: number;
  reportCount: number;
}
interface HIDReportInfo {
  reportId: number;
  items: readonly HIDReportItem[];
}
interface HIDCollectionInfo {
  usagePage: number;
  children: readonly HIDCollectionInfo[];
  outputReports: readonly HIDReportInfo[];
  featureReports: readonly HIDReportInfo[];
}
interface HIDInputReportEvent extends Event {
  reportId: number;
  data: DataView;
}
interface HIDDevice {
  readonly opened: boolean;
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  readonly collections: readonly HIDCollectionInfo[];
  open(): Promise<void>;
  close(): Promise<void>;
  sendReport(reportId: number, data: Uint8Array<ArrayBuffer>): Promise<void>;
  sendFeatureReport(reportId: number, data: Uint8Array<ArrayBuffer>): Promise<void>;
  addEventListener(type: 'inputreport', listener: (event: HIDInputReportEvent) => void): void;
  removeEventListener(type: 'inputreport', listener: (event: HIDInputReportEvent) => void): void;
}
interface HID {
  requestDevice(options: { filters: HIDDeviceFilter[] }): Promise<HIDDevice[]>;
  addEventListener(
    type: 'disconnect',
    listener: (event: Event & { device: HIDDevice }) => void,
  ): void;
  removeEventListener(
    type: 'disconnect',
    listener: (event: Event & { device: HIDDevice }) => void,
  ): void;
}
interface Navigator {
  readonly hid?: HID;
}
