// GET /api/state: the status snapshot plus everything a freshly loaded WebUI
// needs to render without waiting for WS traffic (image versions, the ring
// buffers, stats, identity). Assembled here rather than in web-ui-server.ts to
// keep that file under the 500-line check-loc gate.
import type {
  DeviceIdentity,
  DeviceModelInfo,
  KeyEventEntry,
  LogEntry,
  MockDeviceConfig,
  StateResponse,
  Stats,
  StatusSnapshot,
} from './types.js';
import type { CommEntry, ExtraKeyConfig, RealDeviceIdentity } from '../../types.js';

export interface StateResponseInputs {
  snapshot: StatusSnapshot;
  /** Per-key image version, bumped on each update so the client can cache-bust. */
  imageVersions: { versionFor(key: number): number };
  imageKeys: Iterable<number>;
  activity: { logs: LogEntry[]; comms: CommEntry[]; keyEvents: KeyEventEntry[] };
  stats: Stats;
  mockConfig: MockDeviceConfig;
  resizeEnabled: boolean;
  brightnessOverride: boolean;
  deviceModels: DeviceModelInfo[];
  deviceIdentity: DeviceIdentity;
  realDeviceIdentity?: RealDeviceIdentity;
  extraKeys: Record<string, ExtraKeyConfig>;
  logLevel: string;
  logFilePath: string;
}

export function buildStateResponse(input: StateResponseInputs): StateResponse {
  const images: Record<string, number> = {};
  for (const key of input.imageKeys) images[String(key)] = input.imageVersions.versionFor(key);
  return {
    ...input.snapshot,
    images,
    logs: input.activity.logs,
    commLogs: input.activity.comms,
    keyEvents: input.activity.keyEvents,
    stats: input.stats,
    mockConfig: input.mockConfig,
    resizeEnabled: input.resizeEnabled,
    brightnessOverride: input.brightnessOverride,
    deviceModels: input.deviceModels,
    deviceIdentity: input.deviceIdentity,
    realDeviceIdentity: input.realDeviceIdentity,
    extraKeys: input.extraKeys,
    logLevel: input.logLevel,
    logFilePath: input.logFilePath,
  };
}
