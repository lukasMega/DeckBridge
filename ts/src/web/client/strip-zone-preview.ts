// Touch-strip zone previews: a mirror of the uploads that reached the device
// (WS 'stripWrite'), so every zone canvas shows the device's current pixels whoever
// painted them — app frame, widget, tap flash or clear.

import type { StripWriteMsg, WidgetDisplayInfo } from './ui-types.js';
import { decodeJpeg } from './touch-strip-preview.js';

type Orientation = Pick<WidgetDisplayInfo, 'rotate' | 'flipH' | 'flipV'>;

/** Same cache rule as the server (image-channel.ts): a full write covers every slot. */
let full: string | undefined;
const slots = new Map<number, string>();
const attached = new Map<HTMLCanvasElement, WidgetDisplayInfo>();
// Decoding is async; chaining keeps a later write from landing under an earlier one.
let paintChain: Promise<void> = Promise.resolve();
// Bumped on reset so a decode still in flight for the old dock doesn't paint.
let generation = 0;

/** Draw `img` into a w×h context with the device orientation undone. Rotate 180 and
 *  the flips all map the box onto itself, so they compose in any order. 90/270 would
 *  swap the axes; no strip model uses them, so those draw as-is. */
function drawUnoriented(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  w: number,
  h: number,
  o: Orientation,
): void {
  ctx.save();
  if (o.rotate === 180) {
    ctx.translate(w, h);
    ctx.rotate(Math.PI);
  }
  if (o.flipH) {
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
  }
  if (o.flipV) {
    ctx.translate(0, h);
    ctx.scale(1, -1);
  }
  ctx.drawImage(img, 0, 0, w, h);
  ctx.restore();
}

function unorientedStrip(img: HTMLImageElement, o: Orientation): HTMLCanvasElement {
  const strip = document.createElement('canvas');
  strip.width = img.naturalWidth;
  strip.height = img.naturalHeight;
  const ctx = strip.getContext('2d');
  if (ctx) drawUnoriented(ctx, img, strip.width, strip.height, o);
  return strip;
}

/** Un-oriented full strip per orientation, so one full write decodes and flips once. */
type StripCache = Map<string, HTMLCanvasElement>;

function paintZone(
  canvas: HTMLCanvasElement,
  zone: WidgetDisplayInfo,
  fullImg: HTMLImageElement | null,
  slotImg: HTMLImageElement | null,
  strips: StripCache,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const { stripX, width, height } = zone;
  const fromFull = fullImg !== null && stripX !== undefined;
  if (fromFull) {
    const key = `${zone.rotate},${zone.flipH},${zone.flipV}`;
    const strip = strips.get(key) ?? unorientedStrip(fullImg, zone);
    strips.set(key, strip);
    ctx.drawImage(strip, stripX, 0, width, height, 0, 0, width, height);
  }
  if (slotImg) drawUnoriented(ctx, slotImg, canvas.width, canvas.height, zone);
  if (fromFull || slotImg) delete canvas.dataset.empty;
  else canvas.dataset.empty = 'true';
}

async function paintZones(
  targets: Array<[HTMLCanvasElement, WidgetDisplayInfo]>,
  fullData: string | undefined,
  slotData: ReadonlyMap<number, string>,
  gen: number,
): Promise<void> {
  const fullImg = fullData ? await decodeJpeg(fullData) : null;
  const strips: StripCache = new Map();
  for (const [canvas, zone] of targets) {
    const slot = slotData.get(zone.wireId);
    const slotImg = slot ? await decodeJpeg(slot) : null;
    if (gen !== generation) return;
    paintZone(canvas, zone, fullImg, slotImg, strips);
  }
}

function paint(targets: Array<[HTMLCanvasElement, WidgetDisplayInfo]>): void {
  if (targets.length === 0) return;
  const gen = generation;
  const fullData = full;
  const slotData = new Map(slots);
  // A failed paint must not break the chain for every later write.
  paintChain = paintChain
    .then(() => paintZones(targets, fullData, slotData, gen))
    .catch(() => undefined);
}

function blank(canvas: HTMLCanvasElement): void {
  canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  canvas.dataset.empty = 'true';
}

export function applyStripWrite(msg: StripWriteMsg): void {
  if ('clear' in msg) {
    generation++;
    full = undefined;
    slots.clear();
    for (const canvas of attached.keys()) blank(canvas);
    return;
  }
  if (msg.full) {
    full = msg.data;
    slots.clear();
    paint([...attached]);
    return;
  }
  slots.set(msg.wireId, msg.data);
  paint([...attached].filter(([, zone]) => zone.wireId === msg.wireId));
}

/** Selected dock changed: the server replays the new dock's strip after this. */
export function resetStripZones(): void {
  applyStripWrite({ clear: true });
}

/** Attach a zone canvas and paint it from the writes seen so far; returns the detach. */
export function attachZoneCanvas(canvas: HTMLCanvasElement, zone: WidgetDisplayInfo): () => void {
  attached.set(canvas, zone);
  if (!full && !slots.has(zone.wireId)) blank(canvas);
  else paint([[canvas, zone]]);
  return () => {
    attached.delete(canvas);
  };
}
