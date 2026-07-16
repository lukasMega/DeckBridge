import type { Status, Stats, MockConfig, KeyEvent, ServerLog, CommLog } from './ui-types.js';
import { error } from './log.js';
import { applyImage, clearImage, flashKey, resetPreviews } from './key-preview.js';
import * as store from './store.js';
import type { StoreState } from './store.js';

interface ImageEvt {
  mk2Index: number;
  v: number;
  data?: string;
  format?: string;
}

const handlers: Record<string, (d: unknown) => void> = {
  status: (d) => {
    const next = d as Status;
    // Selected preview dock changed: blank the grids + drop cached images; the
    // server replays the new dock's frames right after this broadcast.
    const prev = store.getSnapshot().status.selectedDock ?? 0;
    if ((next.selectedDock ?? 0) !== prev) {
      resetPreviews();
      store.patch({ images: {} });
    }
    store.setStatus(next);
  },
  image: (d) => {
    const e = d as ImageEvt;
    applyImage(e.mk2Index, { v: e.v, data: e.data, format: e.format });
    store.setImage(e.mk2Index, { v: e.v, data: e.data, format: e.format });
  },
  clear: (d) => {
    const idx = (d as { mk2Index: number }).mk2Index;
    clearImage(idx);
    store.clearImage(idx);
  },
  resizeToggle: (d) => {
    store.setResizeEnabled((d as { enabled: boolean }).enabled);
  },
  imageMode: (d) => {
    store.setImageMode((d as { mode: string | null }).mode);
  },
  brightnessOverride: (d) => {
    store.setBrightnessOverride((d as { enabled: boolean }).enabled);
  },
  brightness: (d) => {
    store.setBrightness((d as { level: number }).level);
  },
  extraKeys: (d) => {
    store.patch({ extraKeys: (d as { configs: StoreState['extraKeys'] }).configs });
  },
  keyEvent: (d) => {
    const e = d as KeyEvent;
    flashKey(e.mk2Index);
    store.addKeyEvent(e);
  },
  // Reserved for a future full-grid refresh; no per-key data accompanies it.
  repaint: () => {},
  log: (d) => {
    store.addServerLog(d as ServerLog);
  },
  comm: (d) => {
    store.addCommLog(d as CommLog);
  },
  commBatch: (d) => {
    for (const e of d as CommLog[]) store.addCommLog(e);
  },
  stats: (d) => {
    store.setStats(d as Stats);
  },
  mockConfig: (d) => {
    store.setMockConfig(d as MockConfig);
  },
};

let _wsConnected = false;

export function connectWS(): void {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/api/ws`);

  ws.addEventListener('open', () => {
    if (_wsConnected) {
      void fetch('/api/state')
        .then((r) => r.json() as Promise<{ images: Record<string, number> }>)
        .then((st) => {
          for (const [k, v] of Object.entries(st.images)) {
            applyImage(Number(k), { v });
            store.setImage(Number(k), { v });
          }
          return undefined;
        });
    }
    _wsConnected = true;
  });

  ws.addEventListener('message', (e: MessageEvent<string>) => {
    const { event, data } = JSON.parse(e.data) as { event: string; data: unknown };
    handlers[event]?.(data);
  });

  ws.addEventListener('close', () => setTimeout(connectWS, 2000));
  ws.addEventListener('error', (e) =>
    error('ws', e instanceof Error ? e.message : 'WebSocket error'),
  );
}
