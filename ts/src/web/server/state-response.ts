// GET /api/state: the status snapshot plus everything a freshly loaded WebUI
// needs to render without waiting for WS traffic (the ring buffers, stats,
// identity). Assembled here rather than in web-ui-server.ts to
// keep that file under the 500-line check-loc gate.
import type {
  DeviceIdentity,
  DeviceModelInfo,
  DriverMode,
  KeyEventEntry,
  LogEntry,
  MockDeviceConfig,
  StateResponse,
  Stats,
  StatusSnapshot,
  UpdateInfo,
} from './types.js';
import { defaultMockConfig } from './mock-config.js';
import { MDNS_SERVICE_NAME } from '../../shared/types.js';
import type {
  CommEntry,
  DockStatus,
  EncoderSettings,
  ExtraKeyConfig,
  RealDeviceIdentity,
  TouchStripMode,
} from '../../shared/types.js';

export interface StateResponseInputs {
  snapshot: StatusSnapshot;
  activity: { logs: LogEntry[]; comms: CommEntry[]; keyEvents: KeyEventEntry[] };
  stats: Stats;
  mockConfig: MockDeviceConfig;
  brightnessOverride: boolean;
  deviceModels: DeviceModelInfo[];
  deviceIdentity: DeviceIdentity;
  realDeviceIdentity?: RealDeviceIdentity;
  extraKeys: Record<string, ExtraKeyConfig>;
  touchStripMode: TouchStripMode;
  touchStripRepaintMs: number;
  encoders: EncoderSettings;
  logLevel: string;
  logFilePath: string;
  multiDeck: boolean;
  updateInfo: UpdateInfo;
}

export function buildStateResponse(input: StateResponseInputs): StateResponse {
  // `rest` is spread last, so the response keeps its original key order.
  const { snapshot, activity, ...rest } = input;
  return {
    ...snapshot,
    // Simple builds have no log/comm panel to render these — omit from the wire
    // payload (client defaults them to [], see hydrate.ts).
    ...(__SIMPLE_ONLY__ ? {} : { logs: activity.logs, commLogs: activity.comms }),
    keyEvents: activity.keyEvents,
    ...rest,
  };
}

/** Identifiers sent to the Elgato app for the SELECTED dock (Settings, read-only):
 *  the selected dock's identity — a mock dock has one too (`mock:<modelId>`) — else
 *  mockConfig in mock mode before the mock connects, else fixed defaults before the
 *  first notifyDocks. */
export function selectedDeviceIdentity(
  driverMode: DriverMode,
  mockConfig: MockDeviceConfig,
  dock: DockStatus | undefined,
): DeviceIdentity {
  if (driverMode === 'mock' && !dock?.deviceKey) {
    return { ...mockConfig, mdnsServiceName: MDNS_SERVICE_NAME };
  }
  if (!dock) return { ...defaultMockConfig(), mdnsServiceName: MDNS_SERVICE_NAME };
  return {
    dockFirmwareVersion: dock.dockFirmwareVersion,
    childFirmwareVersion: dock.childFirmwareVersion,
    serialNumber: dock.serialNumber,
    childSerialNumber: dock.childSerialNumber,
    productId: dock.productId,
    macAddress: dock.macAddress,
    mdnsServiceName: dock.mdnsServiceName,
    deviceKey: dock.deviceKey || undefined,
  };
}
