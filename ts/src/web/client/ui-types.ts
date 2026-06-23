export interface Status {
  driverMode: 'real' | 'mock';
  driverConnected: boolean;
  elgatoConnected: boolean;
  elgatoRemoteAddr?: string | null;
  keyCount?: number;
  columns?: number;
  brightness?: number;
  modelId?: string;
  modelName?: string;
  elgatoAppRunning?: boolean;
  localIp?: string;
}

export interface Stats {
  uptimeMs: number;
  elgatoRxPkts: number;
  elgatoTxPkts: number;
  imagesSent: number;
}

export interface MockConfig {
  dockFirmwareVersion?: string;
  serialNumber?: string;
  childFirmwareVersion?: string;
  childSerialNumber?: string;
  productId?: number;
  macAddress?: string;
}

export interface KeyEvent {
  ts: number;
  mk2Index: number;
  state: 'up' | 'down';
}
export interface ServerLog {
  ts: number;
  level: 'info' | 'warn' | 'error';
  component: string;
  message: string;
}
export interface CommLog {
  ts: number;
  direction: 'rx' | 'tx';
  protocol: string;
  human: string;
  hex?: string;
}
export interface DeviceModel {
  id: string;
  name: string;
  keyCount: number;
}
