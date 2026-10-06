import type { WsEvents } from '../ui-types.js';
import { showDeviceAction } from '../device-test-mode.js';
import { error } from './log.js';
import { applyImage, flashKey, resetPreviews } from '../key-preview.js';
import { applyTouchImage, resetTouchStrip } from '../touch-strip-preview.js';
import { applyStripWrite, resetStripZones } from '../strip-zone-preview.js';
import * as store from './store.js';
import { hydrate } from './hydrate.js';
import type { StateResponse } from '../ui-types.js';

type Handlers = { [K in keyof WsEvents]: (d: WsEvents[K]) => void };

const handlers: Partial<Handlers> = {
  status: (next) => {
    // Selected preview dock changed: blank the grids + drop cached images; the
    // server replays the new dock's frames right after this broadcast.
    if (next.selectedDock !== store.getSnapshot().status.selectedDock) {
      resetPreviews();
      resetTouchStrip();
      resetStripZones();
      store.patch({
        status: next,
        extraKeyImages: {},
        extraKeyClipped: {},
        layoutScope: null,
      });
      return;
    }
    store.patch({ status: next });
  },
  // Imperative only: key-preview.ts paints these, no component reads them from the
  // store. Mirroring each frame in woke every useStore subscriber for nothing.
  image: (e) => applyImage(e.mk2Index, { data: e.data, format: e.format }),
  imagesReset: () => {
    resetPreviews();
    resetTouchStrip();
  },
  touchImage: (d) => applyTouchImage(d),
  stripWrite: (d) => applyStripWrite(d),
  extraKeyImage: ({ wireId, data, clipped, zone }) => {
    const snap = store.getSnapshot();
    const extraKeyClipped = { ...snap.extraKeyClipped };
    if (clipped) extraKeyClipped[String(wireId)] = true;
    else delete extraKeyClipped[String(wireId)];
    if (zone) {
      store.patch({ extraKeyClipped });
      return;
    }
    const extraKeyImages = { ...snap.extraKeyImages };
    if (data) extraKeyImages[String(wireId)] = data;
    else delete extraKeyImages[String(wireId)];
    store.patch({ extraKeyImages, extraKeyClipped });
  },
  brightnessOverride: ({ enabled }) => store.patch({ brightnessOverride: enabled }),
  brightness: ({ level }) => store.patch({ brightness: level }),
  extraKeys: ({ configs }) => store.patch({ extraKeys: configs }),
  pages: ({ pages }) => {
    store.patch({ pages, layoutScope: store.validLayoutScope(pages) });
  },
  pageState: (pageState) => store.patch({ pageState }),
  touchStripMode: ({ mode }) => store.patch({ touchStripMode: mode }),
  touchStripRepaint: ({ ms }) => store.patch({ touchStripRepaintMs: ms }),
  encoders: ({ encoders }) => store.patch({ encoders }),
  deviceAction: (d) => showDeviceAction(d),
  keyEvent: (e) => {
    flashKey(e.mk2Index);
    store.addKeyEvent(e);
  },
  logBatch: (entries) => store.addServerLogs(entries),
  commBatch: (entries) => store.addCommLogs(entries),
  stats: (stats) => store.patch({ stats }),
  ...(__MOCK_BUILD__
    ? { mockConfig: (mockConfig: WsEvents['mockConfig']) => store.patch({ mockConfig }) }
    : {}),
  update: (updateInfo) => store.patch({ updateInfo }),
  pushChannels: ({ channels }) => store.patch({ pushChannels: channels }),
};

// Looked up by the server-sent event name: a Map has no prototype keys to hit.
const handlerByEvent = new Map<string, (d: unknown) => void>(
  Object.entries(handlers) as [string, (d: unknown) => void][],
);

export function connectWS(): void {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/api/ws`);

  ws.addEventListener('open', () => {
    // The server sends the selected dock's frames on connect; drop what a
    // previous connection left before they arrive.
    resetPreviews();
    resetTouchStrip();
    if (store.getSnapshot().connection === 'live') return;
    // Full re-hydrate: an app restart while disconnected changes more than images.
    // Only a fresh snapshot may clear the stale marker; on failure, reconnect again.
    void fetch('/api/state')
      .then((r) => {
        if (!r.ok) throw new Error(`state ${r.status}`);
        return r.json() as Promise<StateResponse>;
      })
      .then((st) => {
        hydrate(st);
        store.patch({ connection: 'live' });
        return undefined;
      })
      .catch(() => ws.close());
  });

  ws.addEventListener('message', (e: MessageEvent<string>) => {
    const { event, data } = JSON.parse(e.data) as { event: string; data: unknown };
    // Each event arrives with its WsEvents payload; `ping` has no handler.
    const handler = handlerByEvent.get(event);
    if (typeof handler === 'function') handler(data);
  });

  ws.addEventListener('close', () => {
    store.patch({ connection: 'stale' });
    setTimeout(connectWS, 2000);
  });
  ws.addEventListener('error', (e) =>
    error('ws', e instanceof Error ? e.message : 'WebSocket error'),
  );
}
