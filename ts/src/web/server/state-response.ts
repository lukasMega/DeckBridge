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
  UpdateInfo,
} from './types.js';
import type {
  CommEntry,
  EncoderSettings,
  ExtraKeyConfig,
  RealDeviceIdentity,
  TouchStripMode,
} from '../../types.js';

export interface StateResponseInputs {
  snapshot: StatusSnapshot;
  /** Per-key image version, bumped on each update so the client can cache-bust. */
  imageVersions: { versionFor(key: number): number };
  imageKeys: Iterable<number>;
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
  const { snapshot, imageVersions, imageKeys, activity, ...rest } = input;
  const images: Record<string, number> = {};
  for (const key of imageKeys) images[String(key)] = imageVersions.versionFor(key);
  return {
    ...snapshot,
    images,
    // Simple builds have no log/comm panel to render these — omit from the wire
    // payload (client defaults them to [], see hydrate.ts).
    ...(__SIMPLE_ONLY__ ? {} : { logs: activity.logs, commLogs: activity.comms }),
    keyEvents: activity.keyEvents,
    ...rest,
  };
}
