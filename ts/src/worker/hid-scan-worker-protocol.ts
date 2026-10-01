import type { LogLevel } from '../shared/logger.js';

export interface HidScanDeviceInfo {
  vendorId: number;
  productId: number;
  usagePage: number;
  usage: number;
  interfaceNumber: number;
  manufacturer: string;
  product: string;
  serial: string;
  path: string;
}

/** `reset`: drop the native cached HidApi before scanning (hid_exit/hid_init), so a
 * replugged device is seen again after a disconnect. Costs one extra init per
 * disconnect, not per tick. */
export type MainToHidScanWorker =
  | { type: 'scan'; reset?: boolean }
  /** Unfiltered inventory for diagnostics; the same worker so a slow hid_enumerate never
   *  runs on the main thread. */
  | { type: 'inventory' };

export type HidScanWorkerToMain =
  | { type: 'scanResult'; devices: HidScanDeviceInfo[]; tookMs: number }
  | { type: 'inventoryResult'; devices: HidScanDeviceInfo[]; tookMs: number; error?: string }
  | { type: 'log'; level: LogLevel; component: string; message: string };
