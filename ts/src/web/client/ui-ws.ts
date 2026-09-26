import type {
  Status,
  Stats,
  MockConfig,
  KeyEvent,
  ServerLog,
  CommLog,
  ExtraKeyImageMsg,
  UpdateInfo,
} from './ui-types.js';
import { showDeviceAction } from './device-test-mode.js';
import { error } from './log.js';
import { applyImage, clearImage, flashKey, resetPreviews } from './key-preview.js';
import { applyTouchImage, resetTouchStrip, type TouchFrameMsg } from './touch-strip-preview.js';
import * as store from './store.js';
import type { StoreState } from './store.js';
import { hydrate, type InitialState } from './hydrate.js';

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
      resetTouchStrip();
      store.patch({ status: next, extraKeyImages: {} });
      return;
    }
    store.patch({ status: next });
  },
  image: (d) => {
    const e = d as ImageEvt;
    // Imperative only: key-preview.ts paints these, no component reads them from the
    // store. Mirroring each frame in woke every useStore subscriber for nothing.
    applyImage(e.mk2Index, { v: e.v, data: e.data, format: e.format });
  },
  touchImage: (d) => {
    applyTouchImage(d as TouchFrameMsg);
  },
  extraKeyImage: (d) => {
    const { wireId, data } = d as ExtraKeyImageMsg;
    const extraKeyImages = { ...store.getSnapshot().extraKeyImages };
    if (data) extraKeyImages[String(wireId)] = data;
    else delete extraKeyImages[String(wireId)];
    store.patch({ extraKeyImages });
  },
  clear: (d) => {
    const idx = (d as { mk2Index: number }).mk2Index;
    clearImage(idx);
  },
  brightnessOverride: (d) => {
    store.patch({ brightnessOverride: (d as { enabled: boolean }).enabled });
  },
  brightness: (d) => {
    store.patch({ brightness: (d as { level: number }).level });
  },
  extraKeys: (d) => {
    store.patch({ extraKeys: (d as { configs: StoreState['extraKeys'] }).configs });
  },
  touchStripMode: (d) => {
    store.patch({ touchStripMode: (d as { mode: StoreState['touchStripMode'] }).mode });
  },
  touchStripRepaint: (d) => {
    store.patch({ touchStripRepaintMs: (d as { ms: number }).ms });
  },
  encoders: (d) => {
    store.patch({ encoders: (d as { encoders: StoreState['encoders'] }).encoders });
  },
  deviceAction: (d) => showDeviceAction(d as { dockIndex: number; message: string }),
  keyEvent: (d) => {
    const e = d as KeyEvent;
    flashKey(e.mk2Index);
    store.addKeyEvent(e);
  },
  // Reserved for a future full-grid refresh; no per-key data accompanies it.
  repaint: () => {},
  logBatch: (d) => {
    for (const e of d as ServerLog[]) store.addServerLog(e);
  },
  comm: (d) => {
    store.addCommLog(d as CommLog);
  },
  commBatch: (d) => {
    for (const e of d as CommLog[]) store.addCommLog(e);
  },
  stats: (d) => {
    store.patch({ stats: d as Stats });
  },
  mockConfig: (d) => {
    store.patch({ mockConfig: d as MockConfig });
  },
  update: (d) => {
    store.patch({ updateInfo: d as UpdateInfo });
  },
};

let _wsConnected = false;

export function connectWS(): void {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/api/ws`);

  ws.addEventListener('open', () => {
    if (_wsConnected) {
      // Full re-hydrate: an app restart while disconnected changes more than images.
      void fetch('/api/state')
        .then((r) => r.json() as Promise<InitialState>)
        .then((st) => {
          hydrate(st);
          return undefined;
        });
    }
    _wsConnected = true;
  });

  ws.addEventListener('message', (e: MessageEvent<string>) => {
    const { event, data } = JSON.parse(e.data) as { event: string; data: unknown };
    if (Object.prototype.hasOwnProperty.call(handlers, event)) {
      const handler = handlers[event];
      if (typeof handler === 'function') {
        handler(data);
      }
    }
  });

  ws.addEventListener('close', () => setTimeout(connectWS, 2000));
  ws.addEventListener('error', (e) =>
    error('ws', e instanceof Error ? e.message : 'WebSocket error'),
  );
}
