import type { DeviceModel } from '../devices/driver.js';
import { DEVICE_MODELS, advertisedGeometry } from '../devices/registry.js';
import type { StateResponse, StatusSnapshot } from '../web/contract.js';

export interface DemoState {
  model: DeviceModel;
  plugged: boolean;
  elgatoConnected: boolean;
  brightness: number;
  brightnessOverride: boolean;
  hardware?: boolean;
  activity?: string;
}

const identity = {
  dockFirmwareVersion: '1.0.0',
  childFirmwareVersion: '1.0.0',
  serialNumber: 'DEMO',
  childSerialNumber: 'DEMO',
  productId: 0,
  macAddress: '00:00:00:00:00:00',
  mdnsServiceName: 'DeckBridge Demo',
};

export function buildStatus(s: DemoState): StatusSnapshot {
  const grid = advertisedGeometry(s.model);
  const geometry = {
    modelId: s.model.id,
    modelName: s.model.name,
    keyCount: grid.keyCount,
    columns: grid.columns,
    rows: grid.rows,
  };
  return {
    ...geometry,
    driverMode: 'real',
    driverConnected: s.plugged,
    elgatoConnected: s.elgatoConnected,
    elgatoRemoteAddr: null,
    clientApp: 'elgato',
    brightness: s.brightness,
    elgatoAppConflict: false,
    elgatoDevicePresent: false,
    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- Fictional LAN address for pairing instructions.
    localIp: '192.168.1.42',
    selectedDock: 0,
    elgatoAutoRestartPending: null,
    docks: [
      {
        ...geometry,
        ...identity,
        index: 0,
        primaryPort: 5330,
        primaryConnected: s.elgatoConnected,
        elgatoConnected: s.elgatoConnected,
        brightness: s.brightness,
        deviceKey: '',
        ...(s.hardware && s.model.protocol === 'ajazz-akp05'
          ? {
              coraProfile: s.model.cora.advertiseAs,
              encoderCount: 4,
              touchStripSize: { width: 800, height: 100 },
            }
          : {}),
      },
    ],
  };
}

export function buildStateResponse(s: DemoState): StateResponse {
  return {
    ...buildStatus(s),
    keyEvents: [],
    logs: [],
    commLogs: [],
    stats: { uptimeMs: 0, elgatoRxPkts: 0, elgatoTxPkts: 0, imagesSent: 0 },
    brightnessOverride: s.brightnessOverride,
    deviceModels: DEVICE_MODELS.map(({ id, name, keyCount }) => ({ id, name, keyCount })),
    deviceIdentity: identity,
    extraKeys: {},
    pages: [],
    pageState: {
      activePageId: null,
      source: 'fingerprint',
      keyCount: advertisedGeometry(s.model).keyCount,
      columns: advertisedGeometry(s.model).columns,
      scores: [],
      suggestedIgnore: [],
      settling: false,
      held: false,
    },
    touchStripMode: 'elgato',
    touchStripRepaintMs: 1000,
    encoders: {},
    logLevel: 'warn',
    logFilePath: '',
    multiDeck: false,
    keyPressEnabled: true,
    updateInfo: { enabled: false, current: __VERSION__, updateAvailable: false },
    elgatoAutoRestart: { enabled: false, delayS: 0, supported: true },
  };
}
