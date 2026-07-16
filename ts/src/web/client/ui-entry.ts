import type {
  Status,
  Stats,
  MockConfig,
  KeyEvent,
  ServerLog,
  CommLog,
  DeviceModel,
  DeviceIdentity,
  ExtraKeyCfg,
} from './ui-types.js';
import { applyImage } from './key-preview.js';
import { connectWS } from './ui-ws.js';
import { mountSimple } from './simple-mount.js';
import { mountAdvanced } from './advanced-mount.js';
import * as store from './store.js';

interface InitialState extends Status {
  stats: Stats;
  mockConfig?: MockConfig;
  images: Record<string, number>;
  logs?: ServerLog[];
  commLogs?: CommLog[];
  keyEvents?: KeyEvent[];
  resizeEnabled?: boolean;
  brightnessOverride?: boolean;
  imageModeOverride?: string | null;
  deviceModels?: DeviceModel[];
  deviceIdentity?: DeviceIdentity;
  extraKeys?: Record<string, ExtraKeyCfg>;
}

void fetch('/api/state')
  .then((r) => r.json() as Promise<InitialState>)
  .then((st) => {
    // Populate store — both Preact views read from here
    store.patch({
      status: st,
      stats: st.stats,
      mockConfig: st.mockConfig,
      brightness: st.brightness ?? 82,
      resizeEnabled: st.resizeEnabled ?? true,
      brightnessOverride: st.brightnessOverride ?? true,
      imageMode: st.imageModeOverride ?? null,
      deviceModels: st.deviceModels ?? [],
      deviceIdentity: st.deviceIdentity,
      extraKeys: st.extraKeys ?? {},
      serverLogs: st.logs ?? [],
      commLogs: st.commLogs ?? [],
      keyEvents: st.keyEvents ?? [],
    });
    for (const [k, v] of Object.entries(st.images)) {
      store.setImage(Number(k), { v });
      applyImage(Number(k), { v });
    }

    // Simple-only build: never reach the advanced view. Clear any persisted
    // 'advanced' mode so a returning user doesn't land on the (absent) view.
    if (__SIMPLE_ONLY__) {
      document.documentElement.removeAttribute('data-mode');
      localStorage.removeItem('deckbridge.mode');
    }

    mountSimple();
    // __SIMPLE_ONLY__ folds to a constant; esbuild DCEs this branch and tree-shakes
    // mountAdvanced → AdvancedApp out of the bundle when building --simple-only.
    if (!__SIMPLE_ONLY__) mountAdvanced();
    connectWS();
    return undefined;
  });
