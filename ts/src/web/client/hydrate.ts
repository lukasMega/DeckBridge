import type {
  Status,
  Stats,
  MockConfig,
  ServerLog,
  CommLog,
  KeyEvent,
  DeviceModel,
  DeviceIdentity,
  EncoderSettings,
  ExtraKeyCfg,
  TouchStripMode,
  UpdateInfo,
} from './ui-types.js';
import { applyImage } from './key-preview.js';
import * as store from './store.js';

export interface InitialState extends Status {
  stats: Stats;
  mockConfig?: MockConfig;
  images: Record<string, number>;
  logs?: ServerLog[];
  commLogs?: CommLog[];
  keyEvents?: KeyEvent[];
  brightnessOverride?: boolean;
  deviceModels?: DeviceModel[];
  deviceIdentity?: DeviceIdentity;
  extraKeys?: Record<string, ExtraKeyCfg>;
  touchStripMode?: TouchStripMode;
  touchStripRepaintMs?: number;
  encoders?: EncoderSettings;
  updateInfo?: UpdateInfo;
}

/** The SELECTED dock's side-key / touch-strip / knob settings. */
function sideKeysState(
  st: InitialState,
): Pick<store.StoreState, 'extraKeys' | 'touchStripMode' | 'touchStripRepaintMs' | 'encoders'> {
  return {
    extraKeys: st.extraKeys ?? {},
    touchStripMode: st.touchStripMode ?? 'elgato',
    touchStripRepaintMs: st.touchStripRepaintMs ?? store.TOUCH_STRIP_REPAINT_DEFAULT_MS,
    encoders: st.encoders ?? {},
  };
}

/**
 * Apply a full /api/state snapshot to the store — shared by first load
 * (ui-entry.ts) and WS reconnect (ui-ws.ts) so a reconnect after an app
 * restart re-hydrates everything first load does, not just images.
 */
export function hydrate(st: InitialState): void {
  store.patch({
    status: st,
    stats: st.stats,
    mockConfig: st.mockConfig,
    brightness: st.brightness ?? 82,
    brightnessOverride: st.brightnessOverride ?? true,
    deviceModels: st.deviceModels ?? [],
    ...sideKeysState(st),
    updateInfo: st.updateInfo,
    serverLogs: st.logs ?? [],
    commLogs: st.commLogs ?? [],
    keyEvents: st.keyEvents ?? [],
  });
  for (const [k, v] of Object.entries(st.images)) {
    applyImage(Number(k), { v });
  }
}
