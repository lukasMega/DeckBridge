// The last CORA key frames per device, kept on disk so a restart can show them (marked
// stale) until the Elgato app repaints. One file per device in <cache>/last-frames/.
// Main thread only. Key frames only: widget, extra-key and touch-strip frames are not saved.
// Saved icons can hold personal data (titles, calendar), hence the age limit, the
// "keep last icons" setting, and diagnostics that report counts and sizes, never pixels.
import { fnv1aHex } from '../shared/types.js';
import { warn } from '../shared/logger.js';
import { defaultCacheRoot } from './native-libs.js';

/** A file older than this is neither replayed nor kept. */
export const FRAME_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Writes are debounced: the frame handler only marks the store dirty. */
export const FRAME_SAVE_DEBOUNCE_MS = 2000;

const MAGIC = 0x44424c46; // 'DBLF'
const VERSION = 1;

/** `<cacheRoot>/last-frames`. */
export function framesDir(cacheRoot: string = defaultCacheRoot()): string {
  return `${cacheRoot}/last-frames`;
}

export interface SavedFrame {
  key: number;
  format: 'jpeg' | 'bmp';
  data: Uint8Array;
}

export interface SavedFrames {
  modelId: string;
  /** When the newest fresh frame arrived (ms since epoch). */
  savedAt: number;
  frames: SavedFrame[];
}

/** What a Dock sees of the store (DockHooks.frameSaver). */
export interface FrameSaver {
  /** The previous run's frames for this device. Handed out once. */
  take(deviceKey: string): SavedFrames | undefined;
  /** Frames changed. O(1): the write is debounced. `null` = nothing left to keep. */
  save(deviceKey: string, snapshot: () => SavedFrames | null): void;
}

/** Counts and sizes only, never pixels (diagnostics). */
export interface SavedFramesInfo {
  modelId: string;
  frames: number;
  bytes: number;
  ageMs: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeFrames(deviceKey: string, saved: SavedFrames): Uint8Array {
  const keyBytes = encoder.encode(deviceKey);
  const modelBytes = encoder.encode(saved.modelId);
  const body = saved.frames.reduce((n, f) => n + 7 + f.data.length, 0);
  const head = 5 + 2 + keyBytes.length + 1 + modelBytes.length + 8 + 2;
  const out = new Uint8Array(head + body);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC);
  out[4] = VERSION;
  view.setUint16(5, keyBytes.length);
  out.set(keyBytes, 7);
  let at = 7 + keyBytes.length;
  out[at++] = modelBytes.length;
  out.set(modelBytes, at);
  at += modelBytes.length;
  view.setFloat64(at, saved.savedAt);
  view.setUint16(at + 8, saved.frames.length);
  at += 10;
  for (const f of saved.frames) {
    view.setUint16(at, f.key);
    out[at + 2] = f.format === 'bmp' ? 1 : 0;
    view.setUint32(at + 3, f.data.length);
    out.set(f.data, at + 7);
    at += 7 + f.data.length;
  }
  return out;
}

/** Null for anything that is not a complete file of this version. */
export function decodeFrames(bytes: Uint8Array): (SavedFrames & { deviceKey: string }) | null {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0) !== MAGIC || bytes[4] !== VERSION) return null;
    const keyLen = view.getUint16(5);
    let at = 7 + keyLen;
    const deviceKey = decoder.decode(bytes.subarray(7, at));
    const modelLen = bytes[at++]!;
    const modelId = decoder.decode(bytes.subarray(at, at + modelLen));
    at += modelLen;
    const savedAt = view.getFloat64(at);
    const count = view.getUint16(at + 8);
    at += 10;
    const frames: SavedFrame[] = [];
    for (let i = 0; i < count; i++) {
      const len = view.getUint32(at + 3);
      if (at + 7 + len > bytes.length) return null;
      frames.push({
        key: view.getUint16(at),
        format: bytes[at + 2] === 1 ? 'bmp' : 'jpeg',
        data: bytes.subarray(at + 7, at + 7 + len),
      });
      at += 7 + len;
    }
    return Number.isFinite(savedAt) ? { deviceKey, modelId, savedAt, frames } : null;
  } catch {
    return null; // a short buffer throws RangeError
  }
}

export interface FrameFs {
  /** Null when the file does not exist. */
  read(path: string): Promise<Uint8Array | null>;
  /** Atomic (temp file + rename); creates the directory. */
  write(path: string, data: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  /** File names; [] when the directory does not exist. */
  list(dir: string): Promise<string[]>;
}

export const tjsFrameFs: FrameFs = {
  async read(path) {
    try {
      return await tjs.readFile(path);
    } catch {
      return null;
    }
  },
  async write(path, data) {
    await tjs.makeDir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    const tmp = `${path}.tmp-${tjs.pid}`;
    await tjs.writeFile(tmp, data);
    await tjs.rename(tmp, path);
  },
  async remove(path) {
    await tjs.remove(path).catch(() => undefined);
  },
  async list(dir) {
    const names: string[] = [];
    try {
      for await (const e of await tjs.readDir(dir)) if (e.isFile) names.push(e.name);
    } catch {}
    return names;
  },
};

export class FrameStore implements FrameSaver {
  private loaded = new Map<string, SavedFrames>();
  private readonly pending = new Map<string, () => SavedFrames | null>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private enabled = true;
  /** Set after any write error: a broken cache dir must never take the app down. */
  private disabled = false;

  /** `fs` and `now` are test seams. */
  constructor(
    private readonly dir: string = framesDir(),
    private readonly fs: FrameFs = tjsFrameFs,
    private readonly now: () => number = Date.now,
  ) {}

  private pathFor(deviceKey: string): string {
    return `${this.dir}/${fnv1aHex(deviceKey)}.bin`;
  }

  /** Read every file before the first dock attaches. A file that is old, of another
   *  version or unreadable is deleted. */
  async load(): Promise<void> {
    for (const name of await this.fs.list(this.dir)) {
      const path = `${this.dir}/${name}`;
      const bytes = await this.fs.read(path);
      const saved = bytes && decodeFrames(bytes);
      if (!saved || this.now() - saved.savedAt > FRAME_MAX_AGE_MS) {
        await this.fs.remove(path);
        continue;
      }
      this.loaded.set(saved.deviceKey, saved);
    }
  }

  take(deviceKey: string): SavedFrames | undefined {
    const saved = this.loaded.get(deviceKey);
    this.loaded.delete(deviceKey);
    return this.enabled ? saved : undefined;
  }

  save(deviceKey: string, snapshot: () => SavedFrames | null): void {
    if (!this.enabled || this.disabled) return;
    this.pending.set(deviceKey, snapshot);
    this.timer ??= setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, FRAME_SAVE_DEBOUNCE_MS);
  }

  /** Write what is pending (the timer, and shutdown). */
  flush(): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const batch = [...this.pending];
    this.pending.clear();
    this.writing = this.writing.then(() => this.writeBatch(batch));
    return this.writing;
  }

  private async writeBatch(batch: [string, () => SavedFrames | null][]): Promise<void> {
    for (const [deviceKey, snapshot] of batch) {
      try {
        const saved = snapshot();
        if (saved && saved.frames.length > 0) {
          await this.fs.write(this.pathFor(deviceKey), encodeFrames(deviceKey, saved));
        } else {
          await this.fs.remove(this.pathFor(deviceKey));
        }
      } catch (e) {
        this.disabled = true;
        warn('frames', `saving last icons failed, disabled: ${(e as Error).message}`);
        return;
      }
    }
  }

  /** The "keep last icons" setting. Off deletes every saved file and saves nothing. */
  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    if (enabled) return;
    this.loaded.clear();
    this.pending.clear();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    await this.writing;
    for (const name of await this.fs.list(this.dir)) await this.fs.remove(`${this.dir}/${name}`);
  }

  /** One entry per saved file, for diagnostics. */
  async info(): Promise<SavedFramesInfo[]> {
    const out: SavedFramesInfo[] = [];
    for (const name of await this.fs.list(this.dir)) {
      const bytes = await this.fs.read(`${this.dir}/${name}`);
      const saved = bytes && decodeFrames(bytes);
      if (!bytes || !saved) continue;
      out.push({
        modelId: saved.modelId,
        frames: saved.frames.length,
        bytes: bytes.length,
        ageMs: Math.max(0, this.now() - saved.savedAt),
      });
    }
    return out;
  }
}
