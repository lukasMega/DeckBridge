/** Generic USB HID worker thread entry point.
 *  Instantiates the right driver (Mirabox or Elgato) based on modelId,
 *  then bridges its EventEmitter events ↔ postMessage. */
import type { MainToWorker, WorkerToMain } from './hid-worker-protocol.js';
import type { ImageModeOverride, KeyEvent } from './types.js';
import { DEVICE_MODELS } from './devices/registry.js';
import type { DeviceModel, DeviceModelOverride } from './devices/driver.js';
import { supportsImageBatching } from './devices/driver.js';
import { applyModelOverrides, overrideSummary } from './devices/model-overrides.js';
import { imageCache } from './image-cache.js';
import { ElgatoHidDriver } from './devices/hid-driver-base.js';
import { MiraboxDriver } from './mirabox.js';
import { renderImage } from './image-render.js';
import { transformImageForDevice } from './translator.js';
import { setWorkerPost, setLogLevel, info } from './logger.js';

const scope = globalThis as unknown as {
  postMessage(msg: WorkerToMain): void;
  onmessage: ((ev: { data: MainToWorker }) => void) | null;
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
};
setWorkerPost(scope.postMessage.bind(scope));

const post = scope.postMessage.bind(scope);

type AnyRealDriver = ElgatoHidDriver | MiraboxDriver;
let driver: AnyRealDriver | null = null;
let currentModel: DeviceModel | null = null;

// WebUI runtime image-mode override (resize ⇄ pad-black/avg/edge), set via
// 'setImageOverride'. null = use the model default. Module-level state is
// safe: the worker processes messages on its serial promise queue (`queue`
// below), so 'setImageOverride' is ordered w.r.t. 'image' messages.
let imageOverride: ImageModeOverride = null;

/** Driver factory keyed on `model.driverKind` — the single touch-point for
 *  registering a new driver implementation (Path C / 'custom' has none yet). */
function createDriver(model: DeviceModel): AnyRealDriver {
  switch (model.driverKind) {
    case 'elgato-hid':
      return new ElgatoHidDriver(model);
    case 'mirabox':
      return new MiraboxDriver(model);
    case 'custom':
      throw new Error(`No driver implementation for driverKind 'custom' (model: ${model.id})`);
  }
}

async function handleOpen(
  modelId: string,
  hidPath?: string,
  overrides?: DeviceModelOverride,
): Promise<void> {
  const registryModel = DEVICE_MODELS.find((m) => m.id === modelId);
  if (!registryModel) {
    post({ type: 'opened', ok: false, error: `Unknown modelId: ${modelId}` });
    return;
  }

  // Same pure merge the main thread ran, applied on top of OUR registry lookup —
  // driverKind/VID/PID therefore always come from the registry, never the message.
  const model = applyModelOverrides(registryModel, overrides);
  // A changed image spec must not be served from entries encoded under the old
  // one. The cache key carries a spec revision too (image-render.ts); clearing
  // here additionally frees the stale entries instead of letting them age out.
  imageCache.clear();
  if (overrides) {
    info('worker', `${model.id} opened with overrides: ${overrideSummary(overrides)}`);
  }

  const d = createDriver(model);
  driver = d;
  currentModel = model;

  d.on('key', (e: KeyEvent) => post({ type: 'key', keyIndex: e.keyIndex, state: e.state }));
  d.on('error', (err: Error) => post({ type: 'error', message: err.message }));
  d.on('disconnect', () => post({ type: 'disconnect' }));
  d.on('reinit', () => post({ type: 'reinit' }));

  try {
    await d.open(hidPath);
    const serial = d instanceof ElgatoHidDriver ? d.deviceSerial : undefined;
    const firmware = d instanceof ElgatoHidDriver ? d.deviceFirmware : undefined;
    post({
      type: 'opened',
      ok: true,
      deviceSerial: serial,
      deviceFirmware: firmware,
      hidPath: d.hidPath,
    });
  } catch (err) {
    post({ type: 'opened', ok: false, error: (err as Error).message });
  }
}

/** Render one CORA image frame: transform (via image-render.ts) + notify main
 *  thread. Guards on driver+currentModel; no-ops if the driver is gone. */
async function handleImage(
  keyIndex: number,
  bytes: Uint8Array,
  format: 'jpeg' | 'bmp',
  deferNotification: boolean,
): Promise<void> {
  if (!driver || !currentModel) return;
  await renderImage(driver, currentModel, keyIndex, bytes, format, imageOverride);
  if (!deferNotification) post({ type: 'imageSent', keyIndex });
}

/** Transform the splash source image with the caller-supplied spec (which may
 *  differ from model.image — see splashSpec() in splash-sender.ts), then write
 *  the native bytes to the device. No LRU caching: splash images are one-shot
 *  on connect and the source bytes are compile-time constants.
 *  Synchronous: transformImageForDevice is a pure FFI call with no async steps;
 *  keeping it sync eliminates the await yield point from the serial message
 *  queue, preventing any event-loop re-entrancy during splash delivery. */
function handleSplashImage(
  keyIndex: number,
  bytes: Uint8Array,
  spec: Parameters<typeof transformImageForDevice>[1],
): void {
  if (!driver) return;
  const nativeBytes = transformImageForDevice(bytes, spec);
  driver.sendImage(keyIndex, nativeBytes);
}

async function handle(msg: MainToWorker, deferNotification: boolean): Promise<void> {
  switch (msg.type) {
    case 'open':
      await handleOpen(msg.modelId, msg.hidPath, msg.overrides);
      break;
    case 'image':
      await handleImage(msg.keyIndex, msg.bytes, msg.format, deferNotification);
      break;
    case 'sendImage':
      driver?.sendImage(msg.keyIndex, msg.bytes);
      break;
    case 'splashImage':
      handleSplashImage(msg.keyIndex, msg.bytes, msg.spec);
      break;
    case 'setBrightness':
      driver?.setBrightness(msg.level);
      break;
    case 'clearKey':
      driver?.clearKey(msg.keyIndex);
      break;
    case 'setImageOverride':
      imageOverride = msg.mode;
      break;
    case 'setLogLevel':
      setLogLevel(msg.level);
      break;
    case 'close': {
      const d = driver;
      driver = null;
      currentModel = null;
      await d?.close().catch(() => undefined);
      post({ type: 'closed' });
      break;
    }
  }
}

let queue: Promise<void> = Promise.resolve();
let pendingImages: MainToWorker[] = [];
let batchTimer: ReturnType<typeof setTimeout> | null = null;

async function handleImageBatch(images: MainToWorker[]): Promise<void> {
  const d = driver;
  if (!(d instanceof MiraboxDriver)) return;
  d.beginImageBatch();
  try {
    for (const msg of images) await handle(msg, true);
  } finally {
    d.endImageBatch();
  }
  for (const msg of images) {
    if (msg.type === 'image') post({ type: 'imageSent', keyIndex: msg.keyIndex });
  }
}

/** Fixed window, never reset by arrivals: animations cannot postpone flushing. */
function enqueueImageBatch(): void {
  if (batchTimer !== null) clearTimeout(batchTimer);
  batchTimer = null;
  if (pendingImages.length === 0) return;
  const images = pendingImages;
  pendingImages = [];
  queue = queue
    .then(() => handleImageBatch(images))
    .catch((e: unknown) => post({ type: 'error', message: (e as Error).message }));
}

scope.addEventListener('message', (ev: MessageEvent) => {
  const msg = ev.data as MainToWorker;
  if (
    currentModel &&
    supportsImageBatching(currentModel) &&
    currentModel.wire.batchImageTransfers === true &&
    (msg.type === 'image' || msg.type === 'sendImage' || msg.type === 'splashImage')
  ) {
    pendingImages.push(msg);
    if (pendingImages.length === 15) enqueueImageBatch();
    else if (batchTimer === null) batchTimer = setTimeout(enqueueImageBatch, 16);
    return;
  }
  // Flush earlier images before clear, settings, close, or another open.
  enqueueImageBatch();
  queue = queue
    .then(() => handle(msg, false))
    .catch((e: unknown) => post({ type: 'error', message: (e as Error).message }));
});
