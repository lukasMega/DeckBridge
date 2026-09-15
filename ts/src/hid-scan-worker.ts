import { DEVICE_MODELS } from './devices/registry.js';
import { resetHidDiscovery, scanSupportedHidDevicesTimed } from './ffi/hid-discovery.js';
import type { HidScanWorkerToMain, MainToHidScanWorker } from './hid-scan-worker-protocol.js';
import { debug, setWorkerPost } from './logger.js';

const scope = globalThis as unknown as {
  postMessage(msg: HidScanWorkerToMain): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
};
const post = scope.postMessage.bind(scope);
setWorkerPost(post);

const supportedPairs = DEVICE_MODELS.flatMap((model) =>
  model.usbProductIds.map((productId) => ({ vendorId: model.usbVendorId, productId })),
);

scope.addEventListener('message', (ev: MessageEvent) => {
  // Reset must happen on this thread: the new IOHIDManager binds to the run loop of
  // whichever thread calls hid_init.
  if ((ev.data as MainToHidScanWorker | undefined)?.reset) {
    debug('hid', `discovery reset: ${resetHidDiscovery() ? 'hid_exit' : 'nothing cached'}`);
  }
  const result = scanSupportedHidDevicesTimed(supportedPairs);
  post({ type: 'scanResult', ...result });
});
