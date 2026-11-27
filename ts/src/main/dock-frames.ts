// A dock's last CORA frame per key, plus the CORA image handler that feeds it.
// The Elgato app keeps its TCP pairing across a USB replug and never re-pushes,
// so these frames are what a replug replays and a live tuning change re-renders.
// The WebUI keeps its own preview cache (web/server/image-channel.ts): that one
// blanks on disconnect, this one must survive it.
import type { DockDriver, RenderOptions } from '../devices/driver.js';
import type { FrameSaver, SavedFrames } from '../infra/frame-store.js';
import type { ImageEvent, TouchWindowRegion } from '../shared/types.js';
import type { ElgatoChildServer } from '../cora/child-server.js';
import { perfOnArrival, perfOnWebUI } from './image-perf.js';
import { mk2IndexToDeviceImgId } from '../shared/key-map.js';
import { sendSplashImages } from '../shared/splash-sender.js';

export type ImageFormat = 'jpeg' | 'bmp';
export type DockFrame = { data: Buffer; format: ImageFormat };

/** After the first fresh frame, a saved frame the app never repaints (another profile)
 *  is blanked and forgotten this long after. */
export const STALE_EXPIRY_MS = 30_000;
const STALE: RenderOptions = { stale: true };

/** What the frames need from their dock. */
export interface FramesLink {
  driver(): DockDriver | null;
  deviceKey(): string | undefined;
  /** Absent for a dock whose frames are not kept across a restart. */
  saver(): FrameSaver | undefined;
  /** Test seam; production uses STALE_EXPIRY_MS. */
  expiryMs?: number;
}

export class LastFrames {
  private readonly frames = new Map<number, DockFrame>();
  /** Keys whose frame is a saved one from the last run, drawn with a "!" until the app
   *  sends a fresh one. Always a subset of `frames`. */
  private readonly stale = new Set<number>();
  private expiry: ReturnType<typeof setTimeout> | null = null;
  /** Time of the newest fresh frame, else of the saved file: saving never refreshes a stale frame's age. */
  private savedAt: number | null = null;

  constructor(private readonly link?: FramesLink) {}

  /** Model of the driver the frames were painted on: a different device must not inherit them. */
  private modelId: string | null = null;
  /** Keys the verify wizard painted during its hold; null = not held (Dock.setVerifyHold). */
  private verifyKeys: Set<number> | null = null;

  /** No copy: `data` is a fresh Buffer.concat result from image-assembler.ts that nothing mutates. */
  record(key: number, data: Buffer, format: ImageFormat): void {
    this.frames.set(key, { data, format });
    this.stale.delete(key);
    this.savedAt = Date.now();
    this.persist();
    if (this.stale.size > 0)
      this.expiry ??= setTimeout(() => this.expireStale(), this.link?.expiryMs ?? STALE_EXPIRY_MS);
  }

  clear(): void {
    const had = this.frames.size > 0;
    this.frames.clear();
    this.stale.clear();
    this.pause();
    if (had) this.persist();
  }

  /** Stop the stale-expiry countdown (detach/stop); the next fresh frame restarts it. */
  pause(): void {
    if (this.expiry !== null) clearTimeout(this.expiry);
    this.expiry = null;
  }

  /** Start from the last run's frames, every one stale. Ignored once frames exist. */
  seedSaved(): void {
    const key = this.link?.deviceKey();
    const saved = key ? this.link?.saver()?.take(key) : undefined;
    if (!saved || this.frames.size > 0) return;
    this.modelId = saved.modelId;
    this.savedAt = saved.savedAt;
    for (const f of saved.frames) {
      this.frames.set(f.key, {
        data: Buffer.from(f.data),
        format: f.format,
      });
      this.stale.add(f.key);
    }
  }

  /** Blank every key still showing a saved frame and forget it (the countdown, or the setting off). */
  expireStale(): void {
    this.pause();
    if (this.stale.size === 0) return;
    const driver = this.link?.driver();
    for (const key of this.stale) {
      this.frames.delete(key);
      const wire = driver ? mk2IndexToDeviceImgId(key, driver.model) : -1;
      if (driver && wire >= 0) driver.clearKey(wire);
    }
    this.stale.clear();
    this.persist();
  }

  /** O(1): the store only marks itself dirty; the snapshot is taken when it writes. */
  private persist(): void {
    const key = this.link?.deviceKey();
    if (key) this.link?.saver()?.save(key, this.snapshotFn);
  }

  private snapshot(): SavedFrames | null {
    if (!this.modelId || this.frames.size === 0) return null;
    return {
      modelId: this.modelId,
      savedAt: this.savedAt ?? Date.now(),
      frames: [...this.frames].map(([key, { data, format }]) => ({ key, format, data })),
    };
  }

  private readonly snapshotFn = (): SavedFrames | null => this.snapshot();

  private opts(key: number): RenderOptions | undefined {
    return this.stale.has(key) ? STALE : undefined;
  }

  freshImage(key: number): Uint8Array | undefined {
    return this.stale.has(key) ? undefined : this.frames.get(key)?.data;
  }

  has(key: number): boolean {
    return this.frames.has(key);
  }

  hasAny(): boolean {
    return this.frames.size > 0;
  }

  /** While held, frames are still recorded but none is drawn. */
  get held(): boolean {
    return this.verifyKeys !== null;
  }

  hold(): void {
    this.verifyKeys ??= new Set();
  }

  /** One verify test-pattern key (a JPEG at the advertised key size); ignored unless held. */
  paintHeld(driver: DockDriver, key: number, bytes: Uint8Array): void {
    if (!this.verifyKeys) return;
    this.verifyKeys.add(key);
    driver.renderCoraImage(key, bytes, 'jpeg');
  }

  /** End the hold. `repaint` re-renders the app's frames (end/cancel; a save leaves it to
   *  the live/reopen path). Keys only the pattern covered are blanked, and without any
   *  app frame the splash comes back, as before the session. */
  release(
    driver: DockDriver | null,
    repaint: boolean,
    mirror?: (key: number, data: Buffer, format: ImageFormat) => void,
  ): void {
    const painted = this.verifyKeys;
    this.verifyKeys = null;
    if (!driver || !painted) return;
    for (const key of painted) {
      const wire = mk2IndexToDeviceImgId(key, driver.model);
      if (!this.frames.has(key) && wire >= 0) driver.clearKey(wire);
    }
    if (this.frames.size === 0) sendSplashImages(driver);
    if (repaint) this.repaint(driver, mirror);
  }

  /** Re-render every frame through the driver (live spec change, standby exit); the frames
   *  themselves are unchanged. `mirror` restores the WebUI preview too. */
  repaint(
    driver: DockDriver,
    mirror?: (key: number, data: Buffer, format: ImageFormat) => void,
  ): void {
    if (this.held) return;
    for (const [key, { data, format }] of this.frames) {
      driver.renderCoraImage(key, data, format, this.opts(key));
      mirror?.(key, data, format);
    }
  }

  /** Re-render only these keys (the info window's source cells after a config change). */
  repaintKeys(driver: DockDriver, keys: readonly number[]): void {
    if (this.held) return;
    for (const key of keys) {
      const frame = this.frames.get(key);
      if (frame) driver.renderCoraImage(key, frame.data, frame.format, this.opts(key));
    }
  }

  /** On (re)attach: paint the app's last frames over the splash when the same model came back
   *  (and restore the preview via `mirror`), else drop them. */
  replay(
    driver: DockDriver,
    mirror?: (key: number, data: Buffer, format: ImageFormat) => void,
  ): void {
    if (this.modelId === driver.model.id) {
      for (const [key, { data, format }] of this.held ? [] : this.frames) {
        driver.renderCoraImage(key, data, format, this.opts(key));
        mirror?.(key, data, format);
      }
    } else {
      this.clear();
    }
    this.modelId = driver.model.id;
  }
}

export interface DockImageSink {
  driver(): DockDriver | null;
  frames: LastFrames;
  /** WebUI mirror of a key image, called after the driver render (USB first). */
  onImage?: (key: number, data: Buffer, format: ImageFormat) => void;
  /** Widgets' repaint-mode hold-off (ExtraKeyWidgets.noteTouchFrame). */
  onTouchFrame?: (region?: TouchWindowRegion) => void;
  /** WebUI mirror of a touch-strip frame. */
  onTouchImage?: (data: Uint8Array, region?: TouchWindowRegion) => void;
  /** Any app frame landed: proof the app is alive (standby exit). Must stay O(1). */
  onAppFrame?: () => void;
  backgroundOwnsKey?: (key: number) => boolean;
}

/** CORA image → device, then → frame store + WebUI mirror. */
export function wireDockImages(
  childServer: Pick<ElgatoChildServer, 'on'>,
  sink: DockImageSink,
): void {
  childServer.on('image', ({ keyIndex, data, format }: ImageEvent) => {
    perfOnArrival();
    const driver = sink.driver();
    // USB latency first: the worker transforms, caches and writes off the main
    // thread, so the FFI transform never stalls this CORA ACK loop. A verify hold
    // keeps the wizard's pattern on the panel; the frame is still recorded below.
    if (!sink.frames.held && !sink.backgroundOwnsKey?.(keyIndex)) {
      driver?.renderCoraImage(keyIndex, data, format);
    }
    // Only frames painted on a device are replayable onto it.
    if (driver) sink.frames.record(keyIndex, data, format);
    sink.onImage?.(keyIndex, data, format);
    sink.onAppFrame?.();
    perfOnWebUI();
  });
  // `region` is set for partial-window uploads, undefined for a full window strip.
  childServer.on(
    'touchImage',
    ({ data, region }: { data: Uint8Array; region?: TouchWindowRegion }) => {
      sink.driver()?.renderTouchImage(data, region);
      sink.onTouchFrame?.(region);
      sink.onTouchImage?.(data, region);
      sink.onAppFrame?.();
    },
  );
}
