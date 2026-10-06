/** Main-thread proxy for the generic USB HID worker.
 *  Presents a DockDriver-shaped surface; forwards to the worker thread
 *  so blocking hid_write never stalls the CORA/WebUI event loop. */
import { EventEmitter } from 'node:events';
import workerSource from 'virtual:hid-worker';
import { revokeBlobUrl, spawnWorker, terminateDeferred } from '../shared/worker-lifecycle.js';
import type { MainToWorker, WorkerToMain } from './hid-worker-protocol.js';
import { HidWorkQueue, type WorkKind, type WorkOptions } from './hid-work-queue-host.js';
import type {
  DockDriver,
  DeviceImageSpec,
  DeviceModel,
  DeviceModelOverride,
} from '../devices/driver.js';
import type {
  KeyEvent,
  DialEvent,
  TouchInputEvent,
  TouchStripOptions,
  TouchWindowRegion,
} from '../shared/types.js';
import { DEFAULT_TOUCH_STRIP_OPTIONS } from '../shared/types.js';
import { log } from '../shared/logger.js';

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

export class WorkerHidDriver extends EventEmitter implements DockDriver {
  /** The EFFECTIVE model (registry entry with the user's device tuning already
   *  applied — see devices/model-overrides.ts). `overrides` is forwarded to the
   *  worker so it can re-derive the same thing from its own registry copy. */
  model: DeviceModel;
  private overrides: DeviceModelOverride | undefined;
  deviceSerial: string | undefined = undefined;
  deviceFirmware: string | undefined = undefined;
  /** HID path the worker opened this device with — see device-identity.ts. */
  hidPath: string | undefined = undefined;
  /** Last options posted — the worker resets to the defaults on open, and so does this. */
  touchStripOptions: TouchStripOptions = DEFAULT_TOUCH_STRIP_OPTIONS;
  private worker: Worker | null = null;
  private objectUrl: string | null = null;
  private openResolve: (() => void) | null = null;
  private openReject: ((err: Error) => void) | null = null;
  private openTimer: ReturnType<typeof setTimeout> | null = null;
  /** One close in flight, shared by every caller; bound to the worker it closes. */
  private closing: {
    worker: Worker;
    promise: Promise<void>;
    resolve: () => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private readonly queue = new HidWorkQueue((msg) => this.worker?.postMessage(msg));
  /** CORA frames stay refused after an overload until the Dock's next CORA child
   *  session (resumeImages): stale ones would paint over a resynced app. */
  private coraSuspended = false;
  /** Local producers (splash, widgets) pause until the work queue drains completely. */
  private localSuspended = false;
  /** After a resume, strip patches wait for a full frame to draw on. */
  private needStripBase = false;

  constructor(model: DeviceModel, overrides?: DeviceModelOverride) {
    super();
    this.model = model;
    this.overrides = overrides;
  }

  /** `hidPath` is the usage-matched HID interface discovery found for this unit. */
  open(hidPath: string): Promise<void> {
    if (this.openReject) {
      return Promise.reject(new Error('open already in flight'));
    }
    if (this.closing) return Promise.reject(new Error('driver is closing'));
    this.touchStripOptions = DEFAULT_TOUCH_STRIP_OPTIONS;
    this.resetGeneration();
    if (!this.worker) {
      const { worker: w, url } = spawnWorker(workerSource);
      this.objectUrl = url;
      this.worker = w;
      w.addEventListener('message', (e: MessageEvent) =>
        this.onWorkerMessage(w, e.data as WorkerToMain),
      );
      w.addEventListener('error', (e) => {
        if (w !== this.worker) return;
        const message = (e as unknown as { message?: string }).message ?? 'worker error';
        if (this.openReject) {
          this.settleOpen(null, new Error(message));
          this.cleanupWorker();
        } else {
          this.reportError(message);
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
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker.postMessage takes no targetOrigin
      this.worker?.postMessage({
        type: 'open',
        modelId: this.model.id,
        hidPath,
        overrides: this.overrides,
      });
    });
  }

  /** Raw CORA image → worker: transform + cache + write happen off the main
   *  thread (P1). No pre-copy here: `post()` (txiki postMessage) always
   *  structured-clones its argument SYNCHRONOUSLY before returning (mod_channel.c
   *  `channel_msg_build` → `JS_WriteObject2` runs in the sender ctx, not deferred),
   *  so the clone can never observe a later mutation of `bytes` — a manual copy
   *  made just before this call would only be copied again by the clone itself. */
  renderCoraImage(keyIndex: number, bytes: Uint8Array, format: 'jpeg' | 'bmp'): void {
    this.submit({ type: 'image', keyIndex, bytes, format }, 'image', {
      bytes: bytes.byteLength,
      coalesceKey: `cora:${keyIndex}`,
      // Waiting means no clone yet, so it must not alias the caller's buffer.
      snapshot: () => ({ type: 'image', keyIndex, bytes: bytes.slice(), format }),
    });
  }

  /** Splash source image → worker: the worker transforms with `spec` (which
   *  may differ from model.image due to splash orientation overrides) and
   *  writes the native bytes to the device. Offloads the synchronous FFI transform
   *  and hid_write burst that would otherwise stall the main thread on connect. */
  sendSplashImage(keyIndex: number, bytes: Uint8Array, spec: DeviceImageSpec): void {
    // No pre-copy: postMessage clones synchronously (see renderCoraImage).
    this.submit({ type: 'imageWithSpec', keyIndex, bytes, spec }, 'image', {
      bytes: bytes.byteLength,
      // A newer icon for the same key and spec replaces a waiting one.
      coalesceKey: `spec:${keyIndex}:${JSON.stringify(spec)}`,
      snapshot: () => ({ type: 'imageWithSpec', keyIndex, bytes: bytes.slice(), spec }),
      local: true,
    });
  }

  /** Stream Deck + window image (or a partial-window region) → worker: split into
   *  the device's touch segments and write each (off the main thread). */
  renderTouchImage(bytes: Uint8Array, region?: TouchWindowRegion): void {
    if (this.needStripBase) {
      if (region) return; // a patch needs the full frame it lands on
      this.needStripBase = false;
    }
    this.submit({ type: 'touchImage', bytes, region }, 'touch', {
      bytes: bytes.byteLength,
      snapshot: () => ({ type: 'touchImage', bytes: bytes.slice(), region }),
    });
  }

  /** Touch-strip zones DeckBridge widgets own — the worker withholds Elgato strip
   *  segments for them. Copied so the caller may reuse its array. */
  setTouchStripMask(wireIds: readonly number[]): void {
    this.control({ type: 'setTouchStripMask', wireIds: [...wireIds] });
  }

  restoreTouchSegments(wireIds: readonly number[]): void {
    this.control({ type: 'restoreTouchSegments', wireIds: [...wireIds] });
  }

  setTouchStripOptions(options: TouchStripOptions): void {
    this.touchStripOptions = options;
    this.control({ type: 'setTouchStripOptions', options: { ...options } });
  }

  setBrightness(level: number): void {
    this.control({ type: 'setBrightness', level });
  }

  setSleep(asleep: boolean): void {
    this.control({ type: 'setSleep', asleep });
  }

  clearKey(keyIndex: number): void {
    this.control({ type: 'clearKey', keyIndex });
  }

  /** Live device-tuning swap (image fields only — see classifyOverrideChange).
   *  `effectiveModel` is resolved by the caller from the same registry entry;
   *  the worker re-merges from its own copy, so this can never change the
   *  driver. Keeping `overrides` current also means a later reopen sends the
   *  new set. The caller repaints — this only changes the spec. */
  applyOverrides(overrides: DeviceModelOverride | undefined, effectiveModel: DeviceModel): void {
    this.overrides = overrides;
    this.model = effectiveModel;
    this.control({ type: 'setOverrides', overrides });
  }

  /** Runtime log-level change — no device I/O, the worker just re-filters. */
  setLogLevel(level: string): void {
    this.control({ type: 'setLogLevel', level });
  }

  /** Concurrent callers share one close. The worker answers 'closed' once its native
   *  handle is released; if that takes longer than CLOSE_GRACE_MS the close rejects and
   *  the worker is left running — terminating it mid native call can SIGBUS the
   *  process — until it does answer (or the process exits). */
  close(): Promise<void> {
    if (this.closing) return this.closing.promise;
    const w = this.worker;
    if (!w) return Promise.resolve();
    this.settleOpen(null, new Error('driver closed'));
    // Unposted frames and settings are moot once the device closes.
    this.resetGeneration();
    const done = Promise.withResolvers<void>();
    const closing = {
      worker: w,
      promise: done.promise,
      resolve: done.resolve,
      reject: done.reject,
      timer: setTimeout(() => this.onCloseTimeout(w), CLOSE_GRACE_MS),
    };
    this.closing = closing;
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker.postMessage takes no targetOrigin
    w.postMessage({ type: 'close' });
    return closing.promise;
  }

  private onCloseTimeout(w: Worker): void {
    const c = this.closing;
    if (c?.worker !== w) return;
    this.closing = null;
    // Detach without terminating; onWorkerMessage terminates it on its late 'closed'.
    if (this.worker === w) this.detachWorker();
    this.orphans.add(w);
    log('warn', this.model.id, `USB worker did not close within ${CLOSE_GRACE_MS}ms`);
    c.reject(new Error('worker close timed out'));
  }

  /** Workers whose close timed out: terminated once they report 'closed'. */
  private readonly orphans = new Set<Worker>();

  /** Lift an overload's CORA suspension: the Dock's CORA child has a fresh session. */
  resumeImages(): void {
    if (!this.coraSuspended) return;
    this.coraSuspended = false;
    this.needStripBase = true;
  }

  /** Queue counters (tests, diagnostics). */
  get workQueue(): HidWorkQueue {
    return this.queue;
  }

  private onOpened(msg: Extract<WorkerToMain, { type: 'opened' }>): void {
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
  }

  private onWorkerMessage(w: Worker, msg: WorkerToMain): void {
    if (w !== this.worker) {
      this.onOrphanMessage(w, msg);
      return;
    }
    if (this.onLifecycleMessage(msg)) return;
    switch (msg.type) {
      case 'opened':
        this.onOpened(msg);
        break;
      case 'key':
        this.emit('key', { keyIndex: msg.keyIndex, state: msg.state } satisfies KeyEvent);
        break;
      case 'dial':
        this.emit('dial', msg.event satisfies DialEvent);
        break;
      case 'touch':
        this.emit('touch', msg.event satisfies TouchInputEvent);
        break;
      case 'inputAction':
        this.emit('inputAction', msg.message);
        break;
      case 'imageSent':
        if (msg.hash !== undefined) this.emit('frameHash', msg.keyIndex, msg.hash);
        this.emit('imageSent', msg.keyIndex);
        break;
      case 'reinit':
        this.emit('reinit');
        break;
      case 'stripWrite':
        this.emit('stripWrite', msg.wireId, msg.bytes, msg.full);
        break;
      // Logged here, not re-emitted: a worker logs from open() on, before any dock listens.
      case 'log':
        log(msg.level, msg.component, msg.message);
        break;
      case 'error':
        this.reportError(msg.message);
        break;
    }
  }

  /** A detached worker is ignored, except that a timed-out close finally finishing
   *  makes it safe to terminate. */
  private onOrphanMessage(w: Worker, msg: WorkerToMain): void {
    if (msg.type === 'closed' && this.orphans.delete(w)) terminateDeferred(w);
  }

  /** Credits and teardown; true when handled. */
  private onLifecycleMessage(msg: WorkerToMain): boolean {
    switch (msg.type) {
      case 'workDone':
        if (this.queue.complete(msg.ids) > 0) this.resumeLocalIfDrained();
        return true;
      case 'disconnect':
        this.emit('disconnect');
        // Same grace as explicit close(): a physical unplug can race an
        // in-flight worker-thread FFI transform or hid_write, and terminating
        // the thread mid native call SIGBUS/SIGSEGVs the whole process.
        this.cleanupWorker(CLOSE_GRACE_MS);
        this.finishClose();
        return true;
      case 'closed':
        this.cleanupWorker();
        this.finishClose();
        return true;
      default:
        return false;
    }
  }

  private reportError(message: string): void {
    log('error', this.model.id, message);
    this.emit('error', new Error(message));
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

  private finishClose(): void {
    const c = this.closing;
    if (!c) return;
    this.closing = null;
    clearTimeout(c.timer);
    c.resolve();
  }

  private control(msg: MainToWorker): void {
    this.submit(msg, 'control', { bytes: 0 });
  }

  // Deliberately NO transfer list: txiki accepts one but only DETACHES the buffers,
  // cloning the content regardless (mod_channel.c). Measured 4 KB..1 MB, transferring
  // is equal-or-slower. Re-measure before adding one.
  /** `local`: a DeckBridge-owned image (splash, widget) — paused by its own suspension,
   *  and its overload doesn't drop the CORA session. */
  private submit(
    msg: MainToWorker,
    kind: WorkKind,
    opts: Omit<WorkOptions, 'kind'> & { local?: boolean },
  ): void {
    if (!this.worker || this.closing) return;
    const { local = false, ...workOpts } = opts;
    if (kind !== 'control') {
      if (local ? this.localSuspended : this.coraSuspended) return;
      // Could never be admitted: drop it rather than suspend everything for nothing.
      if (workOpts.bytes > this.queue.maxPayloadBytes) {
        log('warn', this.model.id, `dropping ${msg.type}: ${workOpts.bytes} bytes exceeds budget`);
        return;
      }
    }
    const admission = this.queue.submit(msg, { ...workOpts, kind });
    if (admission === 'rejected') this.onOverload(local);
    else if (admission === 'failed') log('warn', this.model.id, `posting ${msg.type} failed`);
  }

  private resetGeneration(): void {
    this.queue.reset();
    this.coraSuspended = false;
    this.localSuspended = false;
    this.needStripBase = false;
  }

  /** Out of budget: stop taking images until the backlog clears. One warning per
   *  suspension, so a flood can't flood the log too. A CORA (or control) rejection also
   *  asks the Dock to drop the CORA session; a local one only pauses local producers. */
  private onOverload(local: boolean): void {
    const wasSuspended = this.localSuspended;
    const dropCora = !local && !this.coraSuspended;
    this.localSuspended = true;
    if (!local) this.coraSuspended = true;
    if (!wasSuspended) {
      const q = this.queue;
      log(
        'warn',
        this.model.id,
        `USB worker backlog full (${q.postedCount} posted, ${q.pendingCount} waiting, ` +
          `${q.pendingBytes} bytes) — ${local ? 'pausing local images' : 'dropping the CORA session to resync'}`,
      );
    }
    if (dropCora) this.emit('overload');
  }

  /** The worker has finished everything admitted: local producers may repaint. One
   *  'imagesDrained' per suspension; a close/reopen cleared the flag, so it never fires then. */
  private resumeLocalIfDrained(): void {
    if (!this.localSuspended || !this.queue.isEmpty || !this.worker || this.closing) return;
    this.localSuspended = false;
    this.emit('imagesDrained');
  }

  /** Null the refs synchronously, then defer the native terminate() — see
   *  terminateDeferred (worker-lifecycle.ts) for the txiki libuv-loop footgun and
   *  what `delayMs` buys: 0 when the worker can't be mid native call (open
   *  failure, graceful close), CLOSE_GRACE_MS on a physical disconnect. */
  private cleanupWorker(delayMs = 0): void {
    const w = this.detachWorker();
    if (w) terminateDeferred(w, delayMs);
  }

  /** Forget the worker and this generation's accounting, without terminating it. */
  private detachWorker(): Worker | null {
    const w = this.worker;
    this.worker = null;
    this.resetGeneration();
    if (this.objectUrl) revokeBlobUrl(this.objectUrl);
    this.objectUrl = null;
    return w;
  }
}
