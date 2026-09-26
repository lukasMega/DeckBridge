// Per-dock CORA image cache + the live single-dock channel pushed over WS.
// imageState/imageFormat mirror only the SELECTED dock; dockImages caches every dock's last
// frame so switching is instant (the Elgato app never re-pushes unprompted).
import type { Broadcaster } from './broadcaster.js';
import type { TouchWindowRegion } from '../../types.js';
import type { ExtraKeyImageMsg } from '../contract.js';

export type ImageFormat = 'jpeg' | 'bmp';
export type DockFrame = { data: Buffer; format: ImageFormat };
/** One CORA touch-strip JPEG; no region = the full strip. */
export type TouchFrame = { data: Buffer; region?: TouchWindowRegion };

/** Distinct partial windows kept per dock; the app repaints the same few zones. */
const MAX_TOUCH_FRAMES = 32;

export class ImageChannel {
  readonly imageState = new Map<number, Buffer>();
  readonly imageFormat = new Map<number, ImageFormat>();
  private readonly imageVersion = new Map<number, number>();
  private readonly dockImages = new Map<number, Map<number, DockFrame>>();
  /** Per dock, in paint order: a full strip frame restarts the list, a partial
   *  window replaces the earlier frame for that same window. */
  private readonly dockTouch = new Map<number, Map<string, TouchFrame>>();
  /** Per dock: last widget image painted on each side key, by wire id. */
  private readonly dockExtraKeys = new Map<number, Map<number, Buffer>>();

  constructor(
    private readonly bus: Broadcaster,
    private readonly selectedDock: () => number,
  ) {}

  versionFor(key: number): number {
    return this.imageVersion.get(key) ?? 1;
  }

  notifyImageUpdate(mk2Index: number, data: Buffer, format: ImageFormat = 'jpeg'): void {
    this.imageState.set(mk2Index, data);
    this.imageFormat.set(mk2Index, format);
    const v = (this.imageVersion.get(mk2Index) ?? 0) + 1;
    this.imageVersion.set(mk2Index, v);
    // No browser open → skip the base64 + JSON.stringify entirely; state above still updates so
    // new WS clients snapshot the correct version.
    if (this.bus.size === 0) return;
    this.bus.broadcast('image', { mk2Index, v, data: data.toString('base64'), format });
  }

  /** Always cache the frame for its dock; feed the live channel only when that dock is selected. */
  notifyDockImage(
    dock: number,
    mk2Index: number,
    data: Buffer,
    format: ImageFormat = 'jpeg',
  ): void {
    let cache = this.dockImages.get(dock);
    if (!cache) {
      cache = new Map();
      this.dockImages.set(dock, cache);
    }
    cache.set(mk2Index, { data, format });
    if (dock === this.selectedDock()) this.notifyImageUpdate(mk2Index, data, format);
  }

  /** Cache a touch-strip frame; push it live only when that dock is selected. */
  notifyDockTouchImage(dock: number, bytes: Uint8Array, region?: TouchWindowRegion): void {
    const data = Buffer.from(bytes);
    let frames = this.dockTouch.get(dock);
    if (!frames || !region) {
      frames = new Map();
      this.dockTouch.set(dock, frames);
    }
    const key = region ? `${region.x},${region.y},${region.w},${region.h}` : 'full';
    frames.delete(key);
    frames.set(key, { data, region });
    if (frames.size > MAX_TOUCH_FRAMES) frames.delete(frames.keys().next().value!);
    if (dock === this.selectedDock()) this.broadcastTouch({ data, region });
  }

  /** Cache a side-key widget image (null = cleared); push it live only when that dock is selected. */
  notifyDockExtraKeyImage(dock: number, wireId: number, bmp: Uint8Array | null): void {
    let images = this.dockExtraKeys.get(dock);
    if (!images) {
      images = new Map();
      this.dockExtraKeys.set(dock, images);
    }
    const data = bmp ? Buffer.from(bmp) : undefined;
    if (data) images.set(wireId, data);
    else images.delete(wireId);
    if (dock === this.selectedDock()) this.broadcastExtraKey(wireId, data);
  }

  /** Key images load via /api/state; the strip has no per-key URL, so a new WS
   *  client is sent the selected dock's frames in paint order. */
  sendTouchSnapshot(ws: ServerWebSocket): void {
    for (const frame of this.dockTouch.get(this.selectedDock())?.values() ?? []) {
      this.bus.sendTo(ws, 'touchImage', touchPayload(frame));
    }
    for (const [wireId, data] of this.dockExtraKeys.get(this.selectedDock()) ?? []) {
      this.bus.sendTo(ws, 'extraKeyImage', extraKeyPayload(wireId, data));
    }
  }

  private broadcastExtraKey(wireId: number, data?: Buffer): void {
    if (this.bus.size === 0) return;
    this.bus.broadcast('extraKeyImage', extraKeyPayload(wireId, data));
  }

  private broadcastTouch(frame: TouchFrame): void {
    if (this.bus.size === 0) return;
    this.bus.broadcast('touchImage', touchPayload(frame));
  }

  /** Snapshot of a dock's cached raw CORA frames (repaint-on-replug). Fresh map; buffers shared/immutable. */
  dockFramesSnapshot(dock: number): Map<number, DockFrame> {
    return new Map(this.dockImages.get(dock) ?? []);
  }

  /** Replay a dock's cached frames onto the live channel (dock-select / settings import). */
  replay(dock: number): void {
    for (const [key, { data, format }] of this.dockImages.get(dock) ?? []) {
      this.notifyImageUpdate(key, data, format);
    }
    for (const frame of this.dockTouch.get(dock)?.values() ?? []) this.broadcastTouch(frame);
    for (const [wireId, data] of this.dockExtraKeys.get(dock) ?? []) {
      this.broadcastExtraKey(wireId, data);
    }
  }

  /** Drop caches of docks no longer present (notifyDocks). */
  pruneDeadDocks(liveIndexes: Set<number>): void {
    for (const dock of this.dockImages.keys()) {
      if (!liveIndexes.has(dock)) this.dockImages.delete(dock);
    }
    for (const dock of this.dockTouch.keys()) {
      if (!liveIndexes.has(dock)) this.dockTouch.delete(dock);
    }
    for (const dock of this.dockExtraKeys.keys()) {
      if (!liveIndexes.has(dock)) this.dockExtraKeys.delete(dock);
    }
  }

  clearLive(): void {
    this.imageState.clear();
    this.imageFormat.clear();
  }

  /** Drop one dock's cached per-key images; also clears the live channel if that dock is
   *  selected — returns whether it did, so the caller knows to fire a repaint. */
  reset(dock: number): boolean {
    this.dockImages.delete(dock);
    this.dockTouch.delete(dock);
    const extraKeys = this.dockExtraKeys.get(dock);
    this.dockExtraKeys.delete(dock);
    if (dock !== this.selectedDock()) return false;
    for (const wireId of extraKeys?.keys() ?? []) this.broadcastExtraKey(wireId);
    this.clearLive();
    this.imageVersion.clear();
    return true;
  }
}

export function touchPayload({ data, region }: TouchFrame): {
  data: string;
  region?: TouchWindowRegion;
} {
  return { data: data.toString('base64'), ...(region ? { region } : {}) };
}

function extraKeyPayload(wireId: number, data?: Buffer): ExtraKeyImageMsg {
  return data ? { wireId, data: data.toString('base64') } : { wireId };
}
