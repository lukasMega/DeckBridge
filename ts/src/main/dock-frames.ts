// A dock's last CORA frame per key, plus the CORA image handler that feeds it.
// The Elgato app keeps its TCP pairing across a USB replug and never re-pushes,
// so these frames are what a replug replays and a live tuning change re-renders.
// The WebUI keeps its own preview cache (web/server/image-channel.ts): that one
// blanks on disconnect, this one must survive it.
import type { DockDriver } from '../devices/driver.js';
import type { ImageEvent, TouchWindowRegion } from '../shared/types.js';
import type { ElgatoChildServer } from '../cora/child-server.js';
import { perfOnArrival, perfOnWebUI } from './image-perf.js';

export type ImageFormat = 'jpeg' | 'bmp';
export type DockFrame = { data: Buffer; format: ImageFormat };

export class LastFrames {
  private readonly frames = new Map<number, DockFrame>();
  /** Model of the driver the frames were painted on: a different device must not inherit them. */
  private modelId: string | null = null;

  /** No copy: `data` is a fresh Buffer.concat result from image-assembler.ts that nothing mutates. */
  record(key: number, data: Buffer, format: ImageFormat): void {
    this.frames.set(key, { data, format });
  }

  clear(): void {
    this.frames.clear();
  }

  has(key: number): boolean {
    return this.frames.has(key);
  }

  /** Re-render every frame through the driver (live spec change, standby exit); the frames
   *  themselves are unchanged. `mirror` restores the WebUI preview too. */
  repaint(
    driver: DockDriver,
    mirror?: (key: number, data: Buffer, format: ImageFormat) => void,
  ): void {
    for (const [key, { data, format }] of this.frames) {
      driver.renderCoraImage(key, data, format);
      mirror?.(key, data, format);
    }
  }

  /** On (re)attach: paint the app's last frames over the splash when the same model came back
   *  (and restore the preview via `mirror`), else drop them. */
  replay(
    driver: DockDriver,
    mirror?: (key: number, data: Buffer, format: ImageFormat) => void,
  ): void {
    if (this.modelId === driver.model.id) {
      for (const [key, { data, format }] of this.frames) {
        driver.renderCoraImage(key, data, format);
        mirror?.(key, data, format);
      }
    } else {
      this.frames.clear();
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
    // thread, so the FFI transform never stalls this CORA ACK loop.
    driver?.renderCoraImage(keyIndex, data, format);
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
