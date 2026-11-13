import { info } from '../shared/logger.js';

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

export function perfOnArrival(): void {
  if (!_pt0) _pt0 = Date.now();
  if (_pIdleTimer !== null) clearTimeout(_pIdleTimer);
  _pIdleTimer = setTimeout(perfReset, 3000);
}

export function perfOnWebUI(): void {
  if (!_pt0) return;
  if (++_pWebUI === PERF_BATCH_N) {
    info('perf', `WebUI 15-key batch: +${Date.now() - _pt0}ms (first arrival → last broadcast)`);
    perfReset();
  }
}
