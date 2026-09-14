import type { LogLevel } from './logger.js';

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

export type MainToHidScanWorker = { type: 'scan' };

export type HidScanWorkerToMain =
  | { type: 'scanResult'; devices: HidScanDeviceInfo[]; tookMs: number }
  | { type: 'log'; level: LogLevel; component: string; message: string };
