/** Main-thread proxy for the generic USB HID worker.
 *  Presents a DeviceDriver-shaped surface; forwards to the worker thread
 *  so blocking hid_write never stalls the CORA/WebUI event loop. */
import { EventEmitter } from 'node:events';
import workerSource from 'virtual:hid-worker';
import { revokeBlobUrl, spawnWorker, terminateDeferred } from './worker-lifecycle.js';
import type { MainToWorker, WorkerToMain } from './hid-worker-protocol.js';
import type {
  DeviceDriver,
  DeviceImageSpec,
  DeviceModel,
  DeviceModelOverride,
} from './devices/driver.js';
import type { ImageModeOverride, KeyEvent } from './types.js';

const OPEN_TIMEOUT_MS = 10_000;
const CLOSE_GRACE_MS = 1_000;

/** Detach listeners and close a driver, swallowing close errors. */
export async function closeDriver(d: {
  removeAllListeners(): void;
  close(): Promise<void>;
}): Promise<void> {
  d.removeAllListeners();
  await d.close().catch(() => undefined);
}

export class WorkerHidDriver extends EventEmitter implements DeviceDriver {
  /** The EFFECTIVE model (registry entry with the user's device tuning already
   *  applied — see devices/model-overrides.ts). `overrides` is forwarded to the
   *  worker so it can re-derive the same thing from its own registry copy. */
  model: DeviceModel;
  private overrides: DeviceModelOverride | undefined;
  deviceSerial: string | undefined = undefined;
  deviceFirmware: string | undefined = undefined;
  /** HID path the worker opened this device with — see device-identity.ts. */
  hidPath: string | undefined = undefined;
  private worker: Worker | null = null;
  private objectUrl: string | null = null;
  private openResolve: (() => void) | null = null;
  private openReject: ((err: Error) => void) | null = null;
  private openTimer: ReturnType<typeof setTimeout> | null = null;
  private closeResolve: (() => void) | null = null;

  constructor(model: DeviceModel, overrides?: DeviceModelOverride) {
    super();
    this.model = model;
    this.overrides = overrides;
  }

  /** `hidPath` (optional) targets a specific unclaimed HID interface — used to
   *  open a second unit of the same model. Omitted for the primary probe, which
   *  lets the driver enumerate + open the first usage-matched path. */
  open(hidPath?: string): Promise<void> {
    if (this.openReject) {
      return Promise.reject(new Error('open already in flight'));
    }
    if (!this.worker) {
      const { worker: w, url } = spawnWorker(workerSource);
      this.objectUrl = url;
      this.worker = w;
      w.addEventListener('message', (e: MessageEvent) =>
        this.onWorkerMessage(e.data as WorkerToMain),
      );
      w.addEventListener('error', (e) => {
        const message = (e as unknown as { message?: string }).message ?? 'worker error';
        if (this.openReject) {
          this.settleOpen(null, new Error(message));
          this.cleanupWorker();
        } else {
          this.emit('error', new Error(message));
        }
      });
    }

    return new Promise<void>((resolve, reject) => {
      this.openResolve = resolve;
      this.openReject = reject;
      this.openTimer = setTimeout(() => {
        this.settleOpen(null, new Error('worker open timed out'));
        this.cleanupWorker();
      }, OPEN_TIMEOUT_MS);
      this.post({ type: 'open', modelId: this.model.id, hidPath, overrides: this.overrides });
    });
  }

  /** Raw CORA image → worker: transform + cache + write happen off the main
   *  thread (P1). Copy the bytes so the structured clone never aliases a buffer
   *  the caller may reuse. */
  renderCoraImage(keyIndex: number, bytes: Uint8Array, format: 'jpeg' | 'bmp'): void {
    this.post({ type: 'image', keyIndex, bytes: new Uint8Array(bytes), format });
  }

  sendImage(keyIndex: number, bytes: Uint8Array): void {
    this.post({ type: 'sendImage', keyIndex, bytes: new Uint8Array(bytes) });
  }

  /** Splash source image → worker: the worker transforms with `spec` (which
   *  may differ from model.image due to splash orientation overrides) and
   *  writes the native bytes to the device. Offloads the synchronous FFI transform
   *  and hid_write burst that would otherwise stall the main thread on connect. */
  sendSplashImage(keyIndex: number, bytes: Uint8Array, spec: DeviceImageSpec): void {
    this.post({ type: 'splashImage', keyIndex, bytes: new Uint8Array(bytes), spec });
  }

  setBrightness(level: number): void {
    this.post({ type: 'setBrightness', level });
  }

  clearKey(keyIndex: number): void {
    this.post({ type: 'clearKey', keyIndex });
  }

  /** WebUI runtime image-fit override (resize ⇄ pad-black/avg/edge). No device
   *  I/O — the worker just stores the mode for the next 'image' render. */
  setImageOverride(mode: ImageModeOverride): void {
    this.post({ type: 'setImageOverride', mode });
  }

  /** Live device-tuning swap (image fields only — see classifyOverrideChange).
   *  `effectiveModel` is resolved by the caller from the same registry entry;
   *  the worker re-merges from its own copy, so this can never change the
   *  driver. Keeping `overrides` current also means a later reopen sends the
   *  new set. The caller repaints — this only changes the spec. */
  applyOverrides(overrides: DeviceModelOverride | undefined, effectiveModel: DeviceModel): void {
    this.overrides = overrides;
    this.model = effectiveModel;
    this.post({ type: 'setOverrides', overrides });
  }

  /** Runtime log-level change — no device I/O, the worker just re-filters. */
  setLogLevel(level: string): void {
    this.post({ type: 'setLogLevel', level });
  }

  close(): Promise<void> {
    if (!this.worker) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.closeResolve = resolve;
      this.post({ type: 'close' });
      setTimeout(() => {
        this.cleanupWorker();
        const r = this.closeResolve;
        this.closeResolve = null;
        r?.();
      }, CLOSE_GRACE_MS);
    });
  }

  private onWorkerMessage(msg: WorkerToMain): void {
    switch (msg.type) {
      case 'opened':
        if (msg.ok) {
          this.deviceSerial = msg.deviceSerial;
          this.deviceFirmware = msg.deviceFirmware;
          this.hidPath = msg.hidPath;
          this.settleOpen(this.openResolve, null);
        } else {
          // Failed open: reject but KEEP the worker alive for reuse. Terminating a
          // worker that loaded hidapi is SIGBUS-prone on macOS, and a present-but-
          // unopenable device (Input Monitoring denied) would otherwise spawn+terminate
          // one every reconnect cycle. driver-manager re-issues open() on this instance;
          // close() tears the worker down once, when it is no longer needed.
          this.settleOpen(null, new Error(msg.error));
        }
        break;
      case 'key':
        this.emit('key', { keyIndex: msg.keyIndex, state: msg.state } satisfies KeyEvent);
        break;
      case 'comm':
        this.emit('comm', msg.entry);
        break;
      case 'imageSent':
        this.emit('imageSent', msg.keyIndex);
        break;
      case 'reinit':
        this.emit('reinit');
        break;
      case 'log':
        this.emit('log', { level: msg.level, component: msg.component, message: msg.message });
        break;
      case 'error':
        this.emit('error', new Error(msg.message));
        break;
      case 'disconnect':
        this.emit('disconnect');
        // Same grace as explicit close(): a physical unplug can race an
        // in-flight worker-thread FFI transform or hid_write, and terminating
        // the thread mid native call SIGBUS/SIGSEGVs the whole process.
        this.cleanupWorker(CLOSE_GRACE_MS);
        break;
      case 'closed': {
        this.cleanupWorker();
        const r = this.closeResolve;
        this.closeResolve = null;
        r?.();
        break;
      }
    }
  }

  private settleOpen(resolve: (() => void) | null, err: Error | null): void {
    if (this.openTimer !== null) {
      clearTimeout(this.openTimer);
      this.openTimer = null;
    }
    const reject = this.openReject;
    this.openResolve = null;
    this.openReject = null;
    if (err) reject?.(err);
    else resolve?.();
  }

  // Deliberately NO transfer list: txiki accepts one but only DETACHES the buffers,
  // cloning the content regardless (mod_channel.c). Measured 4 KB..1 MB, transferring
  // is equal-or-slower. Re-measure before adding one.
  private post(msg: MainToWorker): void {
    this.worker?.postMessage(msg);
  }

  /** Null the refs synchronously, then defer the native terminate() — see
   *  terminateDeferred (worker-lifecycle.ts) for the txiki libuv-loop footgun and
   *  what `delayMs` buys: 0 when the worker can't be mid native call (open
   *  failure, graceful close), CLOSE_GRACE_MS on a physical disconnect. */
  private cleanupWorker(delayMs = 0): void {
    const w = this.worker;
    this.worker = null;
    if (w) terminateDeferred(w, delayMs);
    if (this.objectUrl) revokeBlobUrl(this.objectUrl);
    this.objectUrl = null;
  }
}
