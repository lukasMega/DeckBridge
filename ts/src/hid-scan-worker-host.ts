import scanWorkerSource from 'virtual:hid-scan-worker';
import type { HidDeviceInfo } from './ffi/hidapi.js';
import type { MainToHidScanWorker, HidScanWorkerToMain } from './hid-scan-worker-protocol.js';
import { log } from './logger.js';

export interface HidScanResult {
  devices: HidDeviceInfo[];
  tookMs: number;
}

interface ScanWorkerLike {
  postMessage(msg: MainToHidScanWorker): void;
  addEventListener(type: 'message' | 'error', listener: (ev: MessageEvent | Event) => void): void;
}

type ScanWorkerFactory = () => ScanWorkerLike;

function defaultWorkerFactory(): ScanWorkerLike {
  const url = URL.createObjectURL(new Blob([scanWorkerSource], { type: 'application/javascript' }));
  return new Worker(url, { type: 'module' });
}

/** One process-lifetime discovery worker. Concurrent callers share one native scan,
 * so fixed timers cannot queue duplicate scans behind a blocked HID interface. */
export class HidScanWorkerHost {
  private worker: ScanWorkerLike | null = null;
  private inFlight: Promise<HidScanResult> | null = null;
  private resolve: ((result: HidScanResult) => void) | null = null;
  private reject: ((error: Error) => void) | null = null;

  constructor(private readonly workerFactory: ScanWorkerFactory = defaultWorkerFactory) {}

  scan(): Promise<HidScanResult> {
    if (this.inFlight) return this.inFlight;
    this.ensureWorker();
    this.inFlight = new Promise<HidScanResult>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker.postMessage has no targetOrigin
    this.worker!.postMessage({ type: 'scan' });
    return this.inFlight;
  }

  private ensureWorker(): void {
    if (this.worker) return;
    const worker = this.workerFactory();
    worker.addEventListener('message', (ev) =>
      this.onMessage((ev as MessageEvent).data as HidScanWorkerToMain),
    );
    worker.addEventListener('error', (ev) => {
      const message = (ev as unknown as { message?: string }).message ?? 'scan worker error';
      this.worker = null;
      this.settle(null, new Error(message));
    });
    this.worker = worker;
  }

  private onMessage(msg: HidScanWorkerToMain): void {
    if (msg.type === 'log') {
      log(msg.level, msg.component, msg.message);
      return;
    }
    this.settle({ devices: msg.devices, tookMs: msg.tookMs }, null);
  }

  private settle(result: HidScanResult | null, error: Error | null): void {
    const resolve = this.resolve;
    const reject = this.reject;
    this.resolve = null;
    this.reject = null;
    this.inFlight = null;
    if (error) reject?.(error);
    else if (result) resolve?.(result);
  }
}
