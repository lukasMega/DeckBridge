import type { WsEvents } from './ui-types.js';
import { showDeviceAction } from './device-test-mode.js';
import { error } from './log.js';
import { applyImage, flashKey, resetPreviews } from './key-preview.js';
import { applyTouchImage, resetTouchStrip } from './touch-strip-preview.js';
import { applyStripWrite, resetStripZones } from './strip-zone-preview.js';
import * as store from './store.js';
import { hydrate } from './hydrate.js';
import type { StateResponse } from './ui-types.js';

type Handlers = { [K in keyof WsEvents]: (d: WsEvents[K]) => void };

const handlers: Handlers = {
  status: (next) => {
    // Selected preview dock changed: blank the grids + drop cached images; the
    // server replays the new dock's frames right after this broadcast.
    if (next.selectedDock !== store.getSnapshot().status.selectedDock) {
      resetPreviews();
      resetTouchStrip();
      resetStripZones();
      store.patch({ status: next, extraKeyImages: {}, extraKeyClipped: {} });
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
  touchStripMode: ({ mode }) => store.patch({ touchStripMode: mode }),
  touchStripRepaint: ({ ms }) => store.patch({ touchStripRepaintMs: ms }),
  encoders: ({ encoders }) => store.patch({ encoders }),
  deviceAction: (d) => showDeviceAction(d),
  keyEvent: (e) => {
    flashKey(e.mk2Index);
    store.addKeyEvent(e);
  },
  logBatch: (entries) => {
    for (const e of entries) store.addServerLog(e);
  },
  commBatch: (entries) => {
    for (const e of entries) store.addCommLog(e);
  },
  stats: (stats) => store.patch({ stats }),
  mockConfig: (mockConfig) => store.patch({ mockConfig }),
  update: (updateInfo) => store.patch({ updateInfo }),
};

let _wsConnected = false;

export function connectWS(): void {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/api/ws`);

  ws.addEventListener('open', () => {
    // The server sends the selected dock's frames on connect; drop what a
    // previous connection left before they arrive.
    resetPreviews();
    resetTouchStrip();
    if (_wsConnected) {
      // Full re-hydrate: an app restart while disconnected changes more than images.
      void fetch('/api/state')
        .then((r) => r.json() as Promise<StateResponse>)
        .then((st) => {
          hydrate(st);
          return undefined;
        });
    }
    _wsConnected = true;
  });

  ws.addEventListener('message', (e: MessageEvent<string>) => {
    const { event, data } = JSON.parse(e.data) as { event: string; data: unknown };
    if (!Object.prototype.hasOwnProperty.call(handlers, event)) return;
    // The server sends each event with its WsEvents payload; `ping` has no handler.
    const handler = handlers[event as keyof WsEvents] as ((d: unknown) => void) | undefined;
    if (typeof handler === 'function') handler(data);
  });

  ws.addEventListener('close', () => setTimeout(connectWS, 2000));
  ws.addEventListener('error', (e) =>
    error('ws', e instanceof Error ? e.message : 'WebSocket error'),
  );
}
