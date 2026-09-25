/** Generic USB HID worker thread entry point.
 *  Instantiates the right driver (Mirabox or Elgato) based on modelId,
 *  then bridges its EventEmitter events ↔ postMessage. */
import type { MainToWorker, WorkerToMain } from './hid-worker-protocol.js';
import type { ImageModeOverride, KeyEvent, DialEvent, TouchInputEvent } from './types.js';
import { DEVICE_MODELS } from './devices/registry.js';
import type { DeviceModel, DeviceModelOverride } from './devices/driver.js';
import { supportsImageBatching } from './devices/driver.js';
import { applyModelOverrides, overrideSummary, pinsImageFit } from './devices/model-overrides.js';
import { imageCache } from './image-cache.js';
import { ElgatoHidDriver } from './devices/hid-driver-base.js';
import { MiraboxDriver } from './mirabox.js';
import { Akp05Driver } from './devices/ajazz/akp05-driver.js';
import { renderImage, TouchStripCanvas } from './image-render.js';
import { transformImageForDevice } from './translator.js';
import { setWorkerPost, setLogLevel, info } from './logger.js';

const scope = globalThis as unknown as {
  postMessage(msg: WorkerToMain): void;
  onmessage: ((ev: { data: MainToWorker }) => void) | null;
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
};
setWorkerPost(scope.postMessage.bind(scope));

const post = scope.postMessage.bind(scope);

type AnyRealDriver = ElgatoHidDriver | MiraboxDriver | Akp05Driver;
let driver: AnyRealDriver | null = null;
let currentModel: DeviceModel | null = null;
// Registry entry behind currentModel, kept so a live tuning swap ('setOverrides')
// re-merges from the registry instead of layering on an already-merged model.
let openRegistryModel: DeviceModel | null = null;

// WebUI runtime image-mode override (resize ⇄ pad-black/avg/edge), set via
// 'setImageOverride'. null = use the model default. Module-level state is
// safe: the worker processes messages on its serial promise queue (`queue`
// below), so 'setImageOverride' is ordered w.r.t. 'image' messages.
let imageOverride: ImageModeOverride = null;
// Device tuning pins image fit → the legacy imageOverride is ignored for this
// device, otherwise it would overwrite resizeMode/padFill on every render.
let imageFitPinned = false;

// The app's whole strip plus the zones DeckBridge widgets own ('setTouchStripMask'):
// a partial window update lands in place, and masked zones are drawn but never sent.
const touchCanvas = new TouchStripCanvas();

/** Driver factory keyed on `model.driverKind` — the single touch-point for
 *  registering a new driver implementation (Path C / 'custom' has none yet). */
function createDriver(model: DeviceModel): AnyRealDriver {
  switch (model.driverKind) {
    case 'elgato-hid':
      return new ElgatoHidDriver(model);
    case 'mirabox':
      return new MiraboxDriver(model);
    case 'custom':
      if (model.protocol === 'ajazz-akp05') return new Akp05Driver(model);
      throw new Error(`No driver implementation for custom model: ${model.id}`);
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
  imageFitPinned = pinsImageFit(overrides);
  // A changed image spec must not be served from entries encoded under the old
  // one. The cache key carries a spec revision too (image-render.ts); clearing
  // here additionally frees the stale entries instead of letting them age out.
  imageCache.clear();
  touchCanvas.reset();
  if (overrides) {
    info('worker', `${model.id} opened with overrides: ${overrideSummary(overrides)}`);
  }

  const d = createDriver(model);
  driver = d;
  currentModel = model;
  openRegistryModel = registryModel;

  d.on('key', (e: KeyEvent) => post({ type: 'key', keyIndex: e.keyIndex, state: e.state }));
  d.on('dial', (e: DialEvent) => post({ type: 'dial', event: e }));
  d.on('touch', (e: TouchInputEvent) => post({ type: 'touch', event: e }));
  d.on('error', (err: Error) => post({ type: 'error', message: err.message }));
  d.on('disconnect', () => post({ type: 'disconnect' }));
  d.on('reinit', () => post({ type: 'reinit' }));

  try {
    await d.open(hidPath);
    const serial = d instanceof ElgatoHidDriver ? d.deviceSerial : undefined;
    let firmware: string | undefined;
    if (d instanceof ElgatoHidDriver) firmware = d.deviceFirmware;
    else if (d instanceof Akp05Driver) firmware = d.firmware;
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

/** Live device-tuning swap: re-derive the effective model from OUR registry entry
 *  and drop the cache. The open driver instance is deliberately untouched — it
 *  reads nothing from `model.image`, so its wire behaviour cannot change here. */
function applyLiveOverrides(overrides?: DeviceModelOverride): void {
  if (!openRegistryModel) return;
  currentModel = applyModelOverrides(openRegistryModel, overrides);
  imageFitPinned = pinsImageFit(overrides);
  imageCache.clear();
  info('worker', `${currentModel.id} tuning applied live: ${overrideSummary(overrides)}`);
}

/** Render one CORA image frame: transform (via image-render.ts) + notify main
 *  thread. Guards on driver+currentModel; no-ops if the driver is gone. */
function handleImage(
  keyIndex: number,
  bytes: Uint8Array,
  format: 'jpeg' | 'bmp',
  deferNotification: boolean,
): void {
  if (!driver || !currentModel) return;
  const mode = imageFitPinned ? null : imageOverride;
  renderImage(driver, currentModel, keyIndex, bytes, format, mode);
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

type TouchStripMsg = Extract<
  MainToWorker,
  { type: 'touchImage' | 'setTouchStripMask' | 'restoreTouchSegments' | 'setTouchStripOptions' }
>;

function isTouchStripMsg(msg: MainToWorker): msg is TouchStripMsg {
  return (
    msg.type === 'touchImage' ||
    msg.type === 'setTouchStripMask' ||
    msg.type === 'restoreTouchSegments' ||
    msg.type === 'setTouchStripOptions'
  );
}

function handleTouchStripMsg(msg: TouchStripMsg): void {
  if (msg.type === 'setTouchStripOptions') {
    touchCanvas.setOptions(msg.options);
    return;
  }
  const d = driver;
  if (!d || !currentModel) return;
  if (msg.type === 'touchImage') touchCanvas.apply(d, currentModel, msg.bytes, msg.region);
  else if (msg.type === 'setTouchStripMask') touchCanvas.setMask(d, currentModel, msg.wireIds);
  else touchCanvas.restore(d, currentModel, msg.wireIds);
}

/** Non-device state changes: no HID I/O, they only steer the next render. */
function handleSetting(
  msg: Extract<MainToWorker, { type: 'setImageOverride' | 'setOverrides' | 'setLogLevel' }>,
): void {
  if (msg.type === 'setImageOverride') imageOverride = msg.mode;
  else if (msg.type === 'setOverrides') applyLiveOverrides(msg.overrides);
  else setLogLevel(msg.level);
}

async function handle(msg: MainToWorker, deferNotification: boolean): Promise<void> {
  // Device path, not handleSetting: releasing/restoring a zone writes to the device.
  if (isTouchStripMsg(msg)) {
    handleTouchStripMsg(msg);
    return;
  }
  switch (msg.type) {
    case 'open':
      await handleOpen(msg.modelId, msg.hidPath, msg.overrides);
      break;
    case 'image':
      handleImage(msg.keyIndex, msg.bytes, msg.format, deferNotification);
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
    case 'close': {
      const d = driver;
      driver = null;
      currentModel = null;
      openRegistryModel = null;
      touchCanvas.reset();
      await d?.close().catch(() => undefined);
      post({ type: 'closed' });
      break;
    }
    // setImageOverride / setOverrides / setLogLevel — no device I/O.
    default:
      handleSetting(msg);
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
