import { DEVICE_MODELS } from './devices/registry.js';
import { scanSupportedHidDevicesTimed } from './ffi/hid-discovery.js';
import type { HidScanWorkerToMain } from './hid-scan-worker-protocol.js';
import { setWorkerPost } from './logger.js';

const scope = globalThis as unknown as {
  postMessage(msg: HidScanWorkerToMain): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
};
const post = scope.postMessage.bind(scope);
setWorkerPost(post);

const supportedPairs = DEVICE_MODELS.flatMap((model) =>
  model.usbProductIds.map((productId) => ({ vendorId: model.usbVendorId, productId })),
);

scope.addEventListener('message', (_ev: MessageEvent) => {
  const result = scanSupportedHidDevicesTimed(supportedPairs);
  post({ type: 'scanResult', ...result });
});
