import { info } from './logger.js';
import type { DeviceDriver } from './devices/driver.js';
import type { ImageEvent, TouchWindowRegion } from './types.js';
import type { WebUIServer } from './web/server';
import type { ElgatoChildServer } from './elgato.js';

// Image rendering performance tracking (main-thread side)
// Measures first-arrival → last-WebUI-broadcast for a ~15-key profile load. With
// the JPEG/BMP transform now off-thread (image-render.ts on the USB worker, P1),
// this path no longer blocks on synchronous FFI, so the figure reflects pure
// receive + broadcast latency. Compare against the worker's "device 15-key batch".
const PERF_BATCH_N = 15;
let _pt0 = 0;
let _pWebUI = 0;
let _pIdleTimer: number | null = null;

function perfReset(): void {
  _pt0 = 0;
  _pWebUI = 0;
  if (_pIdleTimer !== null) clearTimeout(_pIdleTimer);
  _pIdleTimer = null;
}

function perfOnArrival(): void {
  if (!_pt0) _pt0 = Date.now();
  if (_pIdleTimer !== null) clearTimeout(_pIdleTimer);
  _pIdleTimer = setTimeout(perfReset, 3000);
}

function perfOnWebUI(): void {
  if (!_pt0) return;
  if (++_pWebUI === PERF_BATCH_N) {
    info('perf', `WebUI 15-key batch: +${Date.now() - _pt0}ms (first arrival → last broadcast)`);
    perfReset();
  }
}

export function setupImageHandler(
  childServer: ElgatoChildServer,
  webui: WebUIServer,
  getDriver: () => DeviceDriver | null,
): void {
  childServer.on('image', ({ keyIndex, data, format }: ImageEvent) => {
    perfOnArrival();

    // USB latency first: hand the raw CORA image to the device driver before the
    // WebUI mirror. The worker-backed real driver transforms (resize/rotate/encode),
    // caches, and writes it off the main thread (renderCoraImage → 'image' worker
    // message), so the FFI transform never stalls this CORA ACK loop. MockDriver
    // omits renderCoraImage (its device is virtual), so `?.` makes this a no-op in
    // mock mode.
    getDriver()?.renderCoraImage?.(keyIndex, data, format);

    // WebUI mirror. Dock 0 = primary; the WebUI broadcasts only the selected dock.
    // No copy: `data` is a fresh Buffer.concat result from image-assembler.ts that
    // nothing else mutates, and ImageChannel treats cached frames as shared/immutable
    // (see image-channel.ts's dockFramesSnapshot doc).
    webui.notifyDockImage(0, keyIndex, data, format);
    perfOnWebUI();
  });

  // Stream Deck + window image → device touch-segment displays. `region` is set
  // for partial-window uploads, undefined for a full window strip.
  childServer.on(
    'touchImage',
    ({ data, region }: { data: Uint8Array; region?: TouchWindowRegion }) => {
      getDriver()?.renderTouchImage?.(data, region);
      webui.imageChannel.notifyDockTouchImage(0, data, region);
    },
  );
}
