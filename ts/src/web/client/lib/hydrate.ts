import type { StateResponse } from '../ui-types.js';
import * as store from './store.js';

/**
 * Apply a full /api/state snapshot to the store — shared by first load
 * (ui-entry.ts) and WS reconnect (ui-ws.ts) so a reconnect after an app
 * restart re-hydrates everything first load does. Key images arrive over WS.
 */
export function hydrate(st: StateResponse): void {
  store.patch({
    status: st,
    stats: st.stats,
    ...(__MOCK_BUILD__ ? { mockConfig: st.mockConfig } : {}),
    brightness: st.brightness,
    brightnessOverride: st.brightnessOverride,
    deviceModels: st.deviceModels,
    extraKeys: st.extraKeys,
    touchStripMode: st.touchStripMode,
    touchStripRepaintMs: st.touchStripRepaintMs,
    encoders: st.encoders,
    updateInfo: st.updateInfo,
    keyEvents: st.keyEvents,
  });
  // Absent in simple-only builds (state-response.ts).
  store.replaceLogs(st.logs ?? [], st.commLogs ?? []);
}
