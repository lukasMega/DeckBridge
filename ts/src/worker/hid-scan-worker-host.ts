import scanWorkerSource from 'virtual:hid-scan-worker';
import { revokeBlobUrl, spawnWorker, terminateDeferred } from '../shared/worker-lifecycle.js';
import type { HidDeviceInfo } from '../ffi/hidapi.js';
import type { MainToHidScanWorker, HidScanWorkerToMain } from './hid-scan-worker-protocol.js';
import { log } from '../shared/logger.js';

export interface HidScanResult {
  devices: HidDeviceInfo[];
  tookMs: number;
}

interface ScanWorkerLike {
  postMessage(msg: MainToHidScanWorker): void;
  addEventListener(type: 'message' | 'error', listener: (ev: MessageEvent | Event) => void): void;
  terminate?(): void;
}

/** The blob URL travels with the worker so a replaced worker can release it. */
export interface ScanWorkerHandle {
  worker: ScanWorkerLike;
  url?: string;
}

type ScanWorkerFactory = () => ScanWorkerHandle;

function defaultWorkerFactory(): ScanWorkerHandle {
  return spawnWorker(scanWorkerSource);
}

/** One pending request kind: concurrent callers share its single promise. */
class Slot {
  promise: Promise<HidScanResult> | null = null;
  private resolve: ((r: HidScanResult) => void) | null = null;
  private reject: ((e: Error) => void) | null = null;

  open(): Promise<HidScanResult> {
    this.promise = new Promise<HidScanResult>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    return this.promise;
  }

  settle(result: HidScanResult | null, error: Error | null): void {
    const { resolve, reject } = this;
    this.resolve = null;
    this.reject = null;
    this.promise = null;
    if (error) reject?.(error);
    else if (result) resolve?.(result);
  }
}

/** One process-lifetime discovery worker. Concurrent callers share one native scan,
 * so fixed timers cannot queue duplicate scans behind a blocked HID interface.
 * Diagnostics inventory shares the worker but has its own slot; the worker is serial. */
export class HidScanWorkerHost {
  private current: ScanWorkerHandle | null = null;
  private resetPending = false;
  private readonly scanSlot = new Slot();
  private readonly inventorySlot = new Slot();
  disposed = false;

  constructor(private readonly workerFactory: ScanWorkerFactory = defaultWorkerFactory) {}

  scan(): Promise<HidScanResult> {
    if (this.disposed) return Promise.reject(new Error('HID discovery disposed'));
    if (this.scanSlot.promise) return this.scanSlot.promise;
    const worker = this.ensureWorker();
    const reset = this.resetPending;
    this.resetPending = false;
    const promise = this.scanSlot.open();
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker.postMessage has no targetOrigin
    worker.postMessage(reset ? { type: 'scan', reset: true } : { type: 'scan' });
    return promise;
  }

  /** Every HID interface (unfiltered), for diagnostics only. */
  inventory(): Promise<HidScanResult> {
    if (this.disposed) return Promise.reject(new Error('HID discovery disposed'));
    if (this.inventorySlot.promise) return this.inventorySlot.promise;
    const worker = this.ensureWorker();
    const promise = this.inventorySlot.open();
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker.postMessage has no targetOrigin
    worker.postMessage({ type: 'inventory' });
    return promise;
  }

  /** Shutdown: reject waiting callers now. A native scan still blocked in the worker is
   *  left alone (terminating it mid call is unsafe); its late result is ignored and
   *  process exit reclaims the worker and its still-in-use blob URL. */
  dispose(): void {
    this.disposed = true;
    this.settleAll(new Error('HID discovery disposed'));
  }

  /** Ask the next scan to re-init the native HID stack first (see the `reset` flag in
   *  hid-scan-worker-protocol.ts). Called on disconnect so a replug is enumerable
   *  again; a scan already in flight carries stale state, so the flag survives it. */
  requestReset(): void {
    this.resetPending = true;
  }

  private ensureWorker(): ScanWorkerLike {
    if (this.current) return this.current.worker;
    const handle = this.workerFactory();
    const { worker } = handle;
    // Identity guard: a retired worker's late events must not touch its replacement.
    worker.addEventListener('message', (ev) => {
      if (this.current === handle) this.onMessage((ev as MessageEvent).data as HidScanWorkerToMain);
    });
    worker.addEventListener('error', (ev) => {
      if (this.current !== handle) return;
      const message = (ev as unknown as { message?: string }).message ?? 'scan worker error';
      this.current = null;
      // The errored worker is dead, so a deferred terminate cannot hit a native call.
      if (handle.url) revokeBlobUrl(handle.url);
      if (worker.terminate) terminateDeferred({ terminate: () => worker.terminate?.() });
      this.settleAll(new Error(message));
    });
    this.current = handle;
    return worker;
  }

  private onMessage(msg: HidScanWorkerToMain): void {
    if (msg.type === 'log') {
      log(msg.level, msg.component, msg.message);
      return;
    }
    if (this.disposed) return;
    if (msg.type === 'inventoryResult') {
      if (msg.error) this.inventorySlot.settle(null, new Error(msg.error));
      else this.inventorySlot.settle({ devices: msg.devices, tookMs: msg.tookMs }, null);
      return;
    }
    this.scanSlot.settle({ devices: msg.devices, tookMs: msg.tookMs }, null);
  }

  private settleAll(error: Error): void {
    this.scanSlot.settle(null, error);
    this.inventorySlot.settle(null, error);
  }
}
