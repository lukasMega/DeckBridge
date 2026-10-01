// Touch-strip preview: the Elgato app's strip frames painted in arrival order into
// every mounted canvas — the browser twin of the worker's TouchStripCanvas.

import type { TouchImageMsg as TouchFrameMsg } from './ui-types.js';

/** Same bound + keying as the server cache (image-channel.ts). */
const MAX_FRAMES = 32;

const frames = new Map<string, TouchFrameMsg>();
const canvases = new Set<HTMLCanvasElement>();
/** Work not yet decoded. `target` set = a replay for one freshly attached canvas;
 *  unset = a live frame for every canvas attached when it is painted. */
type Job = { msg: TouchFrameMsg; target?: HTMLCanvasElement };
let queue: Job[] = [];
let pumping = false;
// Bumped on reset so a decode still in flight for the old dock doesn't paint.
let generation = 0;

function frameKey({ region }: TouchFrameMsg): string {
  return region ? `${region.x},${region.y},${region.w},${region.h}` : 'full';
}

/** Decode a base64 JPEG; null when the browser rejects it. */
export async function decodeJpeg(data: string): Promise<HTMLImageElement | null> {
  const img = new Image();
  img.src = `data:image/jpeg;base64,${data}`;
  try {
    await img.decode();
    return img;
  } catch {
    return null;
  }
}

function drawJob(job: Job, img: HTMLImageElement): void {
  const x = job.msg.region?.x ?? 0;
  const y = job.msg.region?.y ?? 0;
  // Read the live set (not a capture) so a detached canvas is never drawn to.
  let targets: Iterable<HTMLCanvasElement> = canvases;
  if (job.target) targets = canvases.has(job.target) ? [job.target] : [];
  for (const canvas of targets) canvas.getContext('2d')?.drawImage(img, x, y);
}

// One decode at a time keeps arrival order; the queue stays bounded by coalescing.
async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const gen = generation;
      // Checked before the decode: a reset or detach must not still pay for it.
      if (canvases.size === 0 || (job.target && !canvases.has(job.target))) continue;
      const img = await decodeJpeg(job.msg.data);
      if (img && gen === generation) drawJob(job, img);
    }
  } catch {
    // A failed paint must not stall every later frame.
  } finally {
    pumping = false;
  }
  if (queue.length > 0) void pump();
}

function enqueue(job: Job): void {
  if (!job.target) {
    if (!job.msg.region) queue = [];
    else {
      const key = frameKey(job.msg);
      // Same window fully overwrites the earlier one, so only the newest is needed.
      queue = queue.filter((j) => j.target || !j.msg.region || frameKey(j.msg) !== key);
    }
  }
  queue.push(job);
  void pump();
}

export function applyTouchImage(msg: TouchFrameMsg): void {
  if (!msg.region) frames.clear();
  const key = frameKey(msg);
  frames.delete(key);
  frames.set(key, msg);
  if (frames.size > MAX_FRAMES) frames.delete(frames.keys().next().value!);
  // No canvas: attachTouchCanvas repaints from the cache.
  if (canvases.size > 0) enqueue({ msg });
}

/** Selected dock changed: the server replays the new dock's strip after this. */
export function resetTouchStrip(): void {
  generation++;
  queue = [];
  frames.clear();
  for (const canvas of canvases) {
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  }
}

/** Attach a canvas and paint the frames seen so far; returns the detach. */
export function attachTouchCanvas(canvas: HTMLCanvasElement): () => void {
  canvases.add(canvas);
  queue = queue.filter((j) => j.target !== canvas);
  for (const msg of frames.values()) enqueue({ msg, target: canvas });
  return () => {
    canvases.delete(canvas);
    queue = queue.filter((j) => j.target !== canvas);
  };
}
