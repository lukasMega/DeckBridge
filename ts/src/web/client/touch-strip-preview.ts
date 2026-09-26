// Touch-strip preview: the Elgato app's strip frames painted in arrival order into
// every mounted canvas — the browser twin of the worker's TouchStripCanvas.

export interface TouchFrameMsg {
  data: string;
  region?: { x: number; y: number; w: number; h: number };
}

/** Same bound + keying as the server cache (image-channel.ts). */
const MAX_FRAMES = 32;

const frames = new Map<string, TouchFrameMsg>();
const canvases = new Set<HTMLCanvasElement>();
// Decoding is async; chaining keeps a later patch from landing under an earlier frame.
let paintChain: Promise<void> = Promise.resolve();
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

async function paintFrames(
  list: HTMLCanvasElement[],
  msgs: TouchFrameMsg[],
  gen: number,
): Promise<void> {
  for (const msg of msgs) {
    const img = await decodeJpeg(msg.data);
    if (!img || gen !== generation) continue;
    for (const canvas of list) {
      canvas.getContext('2d')?.drawImage(img, msg.region?.x ?? 0, msg.region?.y ?? 0);
    }
  }
}

function paint(targets: Iterable<HTMLCanvasElement>, msgs: TouchFrameMsg[]): void {
  const list = [...targets];
  const gen = generation;
  // A failed paint must not break the chain for every later frame.
  paintChain = paintChain.then(() => paintFrames(list, msgs, gen)).catch(() => undefined);
}

export function applyTouchImage(msg: TouchFrameMsg): void {
  if (!msg.region) frames.clear();
  const key = frameKey(msg);
  frames.delete(key);
  frames.set(key, msg);
  if (frames.size > MAX_FRAMES) frames.delete(frames.keys().next().value!);
  paint(canvases, [msg]);
}

/** Selected dock changed: the server replays the new dock's strip after this. */
export function resetTouchStrip(): void {
  generation++;
  frames.clear();
  for (const canvas of canvases) {
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  }
}

/** Attach a canvas and paint the frames seen so far; returns the detach. */
export function attachTouchCanvas(canvas: HTMLCanvasElement): () => void {
  canvases.add(canvas);
  paint([canvas], [...frames.values()]);
  return () => {
    canvases.delete(canvas);
  };
}
