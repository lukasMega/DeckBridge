export interface DeviceConfig {
  dockFirmwareVersion: string;
  childFirmwareVersion: string;
  serialNumber: string;
  childSerialNumber: string;
  productId: number;
  macAddress: number[];
}

export type LogFn = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
