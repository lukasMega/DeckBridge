// Per-dock CORA image cache + the live single-dock channel pushed over WS.
// dockImages caches every dock's last frame so switching is instant (the Elgato app
// never re-pushes unprompted); only the SELECTED dock's frames reach the browser.
import type { Broadcaster } from './broadcaster.js';
import type { TouchWindowRegion } from '../../shared/types.js';
import type { ExtraKeyImageMsg, KeyImageMsg, StripWriteMsg } from '../contract.js';
import type { WidgetPaint } from '../../shared/widget-layout.js';

export type ImageFormat = 'jpeg' | 'bmp';
export type DockFrame = { data: Buffer; format: ImageFormat };
/** One CORA touch-strip JPEG; no region = the full strip. */
export type TouchFrame = { data: Buffer; region?: TouchWindowRegion };

/** The device's current strip pixels: a full-strip write covers every slot. */
type StripMirror = { full?: { wireId: number; data: Buffer }; slots: Map<number, Buffer> };

/** Distinct partial windows kept per dock; the app repaints the same few zones. */
const MAX_TOUCH_FRAMES = 32;

export class ImageChannel {
  private readonly dockImages = new Map<number, Map<number, DockFrame>>();
  /** Per dock, in paint order: a full strip frame restarts the list, a partial
   *  window replaces the earlier frame for that same window. */
  private readonly dockTouch = new Map<number, Map<string, TouchFrame>>();
  /** Per dock: last widget paint on each side key / strip zone, by wire id. */
  private readonly dockExtraKeys = new Map<number, Map<number, WidgetPaint>>();
  /** Per dock: mirror of the touch-strip uploads that reached the device. */
  private readonly dockStrip = new Map<number, StripMirror>();

  constructor(
    private readonly bus: Broadcaster,
    private readonly selectedDock: () => number,
  ) {}

  /** The selected dock's cached key frames. */
  selectedImages(): ReadonlyMap<number, DockFrame> {
    return this.dockImages.get(this.selectedDock()) ?? new Map();
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
    if (dock === this.selectedDock()) this.broadcastImage(mk2Index, { data, format });
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

  /** Cache a widget paint (null = cleared); push it live only when that dock is selected. */
  notifyDockWidgetPaint(dock: number, wireId: number, paint: WidgetPaint | null): void {
    let paints = this.dockExtraKeys.get(dock);
    if (!paints) {
      paints = new Map();
      this.dockExtraKeys.set(dock, paints);
    }
    if (paint) paints.set(wireId, paint);
    else paints.delete(wireId);
    if (dock === this.selectedDock()) this.broadcastExtraKey(wireId, paint ?? undefined);
  }

  /** Cache a device strip upload; push it live only when that dock is selected. */
  notifyDockStripWrite(dock: number, wireId: number, bytes: Uint8Array, full: boolean): void {
    const data = Buffer.from(bytes);
    let mirror = this.dockStrip.get(dock);
    if (!mirror) {
      mirror = { slots: new Map() };
      this.dockStrip.set(dock, mirror);
    }
    if (full) {
      mirror.full = { wireId, data };
      mirror.slots.clear();
    } else {
      mirror.slots.set(wireId, data);
    }
    if (dock === this.selectedDock()) this.broadcastStrip(stripPayload(wireId, data, full));
  }

  /** Last paint of one of the selected dock's widgets (size previews re-lay its lines). */
  selectedWidgetPaint(wireId: number): WidgetPaint | undefined {
    return this.dockExtraKeys.get(this.selectedDock())?.get(wireId);
  }

  /** A new WS client is sent the selected dock's frames: keys, then the strip in paint order. */
  sendSnapshot(ws: ServerWebSocket): void {
    for (const [mk2Index, frame] of this.selectedImages()) {
      this.bus.sendTo(ws, 'image', imagePayload(mk2Index, frame));
    }
    for (const frame of this.dockTouch.get(this.selectedDock())?.values() ?? []) {
      this.bus.sendTo(ws, 'touchImage', touchPayload(frame));
    }
    for (const [wireId, paint] of this.dockExtraKeys.get(this.selectedDock()) ?? []) {
      this.bus.sendTo(ws, 'extraKeyImage', extraKeyPayload(wireId, paint));
    }
    for (const msg of stripMessages(this.dockStrip.get(this.selectedDock()))) {
      this.bus.sendTo(ws, 'stripWrite', msg);
    }
  }

  private broadcastImage(mk2Index: number, frame: DockFrame): void {
    // No browser open → skip the base64 + JSON.stringify entirely.
    if (this.bus.size === 0) return;
    this.bus.broadcast('image', imagePayload(mk2Index, frame));
  }

  private broadcastStrip(msg: StripWriteMsg): void {
    if (this.bus.size === 0) return;
    this.bus.broadcast('stripWrite', msg);
  }

  private broadcastExtraKey(wireId: number, paint?: WidgetPaint): void {
    if (this.bus.size === 0) return;
    this.bus.broadcast('extraKeyImage', extraKeyPayload(wireId, paint));
  }

  private broadcastTouch(frame: TouchFrame): void {
    if (this.bus.size === 0) return;
    this.bus.broadcast('touchImage', touchPayload(frame));
  }

  /** Replay a dock's cached frames onto the live channel (dock-select / settings import). */
  replay(dock: number): void {
    for (const [key, frame] of this.dockImages.get(dock) ?? []) this.broadcastImage(key, frame);
    for (const frame of this.dockTouch.get(dock)?.values() ?? []) this.broadcastTouch(frame);
    for (const [wireId, paint] of this.dockExtraKeys.get(dock) ?? []) {
      this.broadcastExtraKey(wireId, paint);
    }
    for (const msg of stripMessages(this.dockStrip.get(dock))) this.broadcastStrip(msg);
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
    for (const dock of this.dockStrip.keys()) {
      if (!liveIndexes.has(dock)) this.dockStrip.delete(dock);
    }
  }

  /** Drop one dock's cached frames; returns whether that dock is selected, so the
   *  caller knows to tell the browser its previews are gone. */
  reset(dock: number): boolean {
    this.dockImages.delete(dock);
    this.dockTouch.delete(dock);
    const extraKeys = this.dockExtraKeys.get(dock);
    this.dockExtraKeys.delete(dock);
    this.dockStrip.delete(dock);
    if (dock !== this.selectedDock()) return false;
    for (const wireId of extraKeys?.keys() ?? []) this.broadcastExtraKey(wireId);
    this.broadcastStrip({ clear: true });
    return true;
  }
}

function imagePayload(mk2Index: number, { data, format }: DockFrame): KeyImageMsg {
  return { mk2Index, data: data.toString('base64'), format };
}

export function touchPayload({ data, region }: TouchFrame): {
  data: string;
  region?: TouchWindowRegion;
} {
  return { data: data.toString('base64'), ...(region ? { region } : {}) };
}

/** A strip zone's image is not mirrored (the strip preview shows the app's frames). */
function extraKeyPayload(wireId: number, paint?: WidgetPaint): ExtraKeyImageMsg {
  if (!paint) return { wireId };
  return {
    wireId,
    ...(paint.zone ? { zone: true } : { data: Buffer.from(paint.bmp).toString('base64') }),
    ...(paint.clipped ? { clipped: true } : {}),
  };
}

function stripPayload(wireId: number, data: Buffer, full: boolean): StripWriteMsg {
  return { wireId, data: data.toString('base64'), ...(full ? { full: true as const } : {}) };
}

/** Clear first, then full before slots: that order rebuilds the device's pixels. */
function stripMessages(mirror: StripMirror | undefined): StripWriteMsg[] {
  const messages: StripWriteMsg[] = [{ clear: true }];
  if (!mirror) return messages;
  if (mirror.full) messages.push(stripPayload(mirror.full.wireId, mirror.full.data, true));
  for (const [wireId, data] of mirror.slots) messages.push(stripPayload(wireId, data, false));
  return messages;
}
