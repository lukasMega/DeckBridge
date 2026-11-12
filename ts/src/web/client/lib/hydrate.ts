import type { StateResponse, WslRelayStatus } from '../ui-types.js';
import { getJson } from './ui-api.js';
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
    pages: st.pages,
    layoutScope:
      st.selectedDock === store.getSnapshot().status.selectedDock
        ? store.validLayoutScope(st.pages)
        : null,
    pageState: st.pageState,
    touchStripMode: st.touchStripMode,
    touchStripRepaintMs: st.touchStripRepaintMs,
    encoders: st.encoders,
    updateInfo: st.updateInfo,
    keyPressEnabled: st.keyPressEnabled,
    extensions: st.extensions,
    keyEvents: st.keyEvents,
  });
  // Absent in simple-only builds (state-response.ts).
  store.replaceLogs(st.logs ?? [], st.commLogs ?? []);
  void loadWslRelay();
}

/** Not part of /api/state: a failed read means no WSL relay here, so its UI stays hidden. */
async function loadWslRelay(): Promise<void> {
  // A WS `wslRelay` event that lands while the GET is in flight is newer than its reply.
  const before = store.getSnapshot().wslRelay;
  const apply = (wslRelay: WslRelayStatus | null): void => {
    if (store.getSnapshot().wslRelay === before) store.patch({ wslRelay });
  };
  try {
    apply(await getJson<WslRelayStatus>('/api/wsl-relay'));
  } catch {
    apply(null);
  }
}
