/** Host-side admission for one USB worker (main thread; `-host` so the boundaries
 *  lint files it with hid-worker-host.ts). Bounds what is posted but not yet done
 *  (the worker acknowledges each id with `workDone`) and what waits on the main
 *  thread, so a slow hid_write can't grow structured-clone backlog without limit
 *  while CORA keeps acknowledging. Pure: no Worker, no timers — the host injects `send`. */
import type { MainToWorker } from './hid-worker-protocol.js';

export interface WorkBudgets {
  /** Posted, not yet acknowledged: messages and payload bytes (worker-side clones). */
  postedCount: number;
  postedBytes: number;
  /** Waiting on the main thread for posting capacity. */
  pendingCount: number;
  pendingBytes: number;
  /** Extra waiting slots only control messages may use, so a backlog of frames can't
   *  cost a brightness, clear or mask change. */
  controlReserve: number;
}

const MiB = 1024 * 1024;

/** postedCount matches the worker's 15-image batch, so a full batch can be in flight. */
export const DEFAULT_WORK_BUDGETS: WorkBudgets = {
  postedCount: 15,
  postedBytes: 2 * MiB,
  pendingCount: 64,
  pendingBytes: 4 * MiB,
  controlReserve: 32,
};

/** 'image' = a complete key image (coalescable); 'touch' = a strip frame or patch
 *  (strict FIFO); 'control' = ordered state change (a barrier for coalescing). */
export type WorkKind = 'image' | 'touch' | 'control';

export interface WorkOptions {
  kind: WorkKind;
  /** Payload bytes the message carries (0 for control). */
  bytes: number;
  /** Images with the same key replace each other while both still wait. */
  coalesceKey?: string;
  /** Called only when the message has to wait: return a copy the caller can't mutate. */
  snapshot?: () => MainToWorker;
}

/** posted/queued/coalesced = admitted; rejected = over budget (overload); failed = postMessage threw. */
export type Admission = 'posted' | 'queued' | 'coalesced' | 'rejected' | 'failed';

interface Waiting {
  msg: MainToWorker;
  kind: WorkKind;
  bytes: number;
  coalesceKey?: string;
}

export interface WorkQueueStats {
  peakPendingBytes: number;
  peakPostedBytes: number;
  coalesced: number;
}

export class HidWorkQueue {
  private readonly send: (msg: MainToWorker & { id: number }) => void;
  private readonly budgets: WorkBudgets;
  /** Never reused, so a completion from an older generation can't match a new id. */
  private nextId = 1;
  private readonly posted = new Map<number, number>();
  private postedBytes = 0;
  private waiting: Waiting[] = [];
  private waitingBytes = 0;
  readonly stats: WorkQueueStats = { peakPendingBytes: 0, peakPostedBytes: 0, coalesced: 0 };

  constructor(
    send: (msg: MainToWorker & { id: number }) => void,
    budgets: WorkBudgets = DEFAULT_WORK_BUDGETS,
  ) {
    this.send = send;
    this.budgets = budgets;
  }

  get postedCount(): number {
    return this.posted.size;
  }

  get pendingCount(): number {
    return this.waiting.length;
  }

  get pendingBytes(): number {
    return this.waitingBytes;
  }

  /** Largest single payload that can ever be admitted. */
  get maxPayloadBytes(): number {
    return this.budgets.postedBytes;
  }

  /** Nothing posted and nothing waiting: the worker has finished every admitted message. */
  get isEmpty(): boolean {
    return this.posted.size === 0 && this.waiting.length === 0;
  }

  get inFlightBytes(): number {
    return this.postedBytes;
  }

  submit(msg: MainToWorker, opts: WorkOptions): Admission {
    // Must fit the posted budget on its own, or it could never be posted.
    if (opts.bytes > this.budgets.postedBytes) return 'rejected';
    // Nothing waits ahead of it: post now (FIFO is trivially kept).
    if (this.waiting.length === 0 && this.fitsPosted(opts.bytes)) {
      return this.post(msg, opts.bytes) ? 'posted' : 'failed';
    }
    const superseded = opts.coalesceKey ? this.supersededIndex(opts.coalesceKey) : -1;
    const freedBytes = superseded >= 0 ? this.waiting[superseded]!.bytes : 0;
    const freedCount = superseded >= 0 ? 1 : 0;
    const countLimit =
      this.budgets.pendingCount + (opts.kind === 'control' ? this.budgets.controlReserve : 0);
    if (
      this.waiting.length - freedCount >= countLimit ||
      this.waitingBytes - freedBytes + opts.bytes > this.budgets.pendingBytes
    ) {
      return 'rejected';
    }
    if (superseded >= 0) {
      this.waiting.splice(superseded, 1);
      this.waitingBytes -= freedBytes;
      this.stats.coalesced++;
    }
    this.waiting.push({
      msg: opts.snapshot ? opts.snapshot() : msg,
      kind: opts.kind,
      bytes: opts.bytes,
      coalesceKey: opts.coalesceKey,
    });
    this.waitingBytes += opts.bytes;
    this.stats.peakPendingBytes = Math.max(this.stats.peakPendingBytes, this.waitingBytes);
    return superseded >= 0 ? 'coalesced' : 'queued';
  }

  /** The worker finished (wrote, skipped or failed) these ids. Unknown ids — stale
   *  generation or duplicates — are ignored. Returns how many current credits it released. */
  complete(ids: readonly number[]): number {
    let released = 0;
    for (const id of ids) {
      const bytes = this.posted.get(id);
      if (bytes === undefined) continue;
      this.posted.delete(id);
      this.postedBytes -= bytes;
      released++;
    }
    this.drain();
    return released;
  }

  /** Generation change (open, close, disconnect): forget everything, never replay. */
  reset(): void {
    this.posted.clear();
    this.postedBytes = 0;
    this.waiting = [];
    this.waitingBytes = 0;
  }

  private drain(): void {
    while (this.waiting.length > 0 && this.fitsPosted(this.waiting[0]!.bytes)) {
      const next = this.waiting.shift()!;
      this.waitingBytes -= next.bytes;
      this.post(next.msg, next.bytes);
    }
  }

  /** Only inside the trailing run of complete images: a touch frame or control
   *  message behind an image keeps everything before it in order. */
  private supersededIndex(key: string): number {
    for (let i = this.waiting.length - 1; i >= 0; i--) {
      const w = this.waiting[i]!;
      if (w.kind !== 'image') return -1;
      if (w.coalesceKey === key) return i;
    }
    return -1;
  }

  private fitsPosted(bytes: number): boolean {
    return (
      this.posted.size < this.budgets.postedCount &&
      this.postedBytes + bytes <= this.budgets.postedBytes
    );
  }

  /** Reserve the credit first; give it back if postMessage throws. */
  private post(msg: MainToWorker, bytes: number): boolean {
    const id = this.nextId++;
    this.posted.set(id, bytes);
    this.postedBytes += bytes;
    try {
      this.send({ ...msg, id });
    } catch {
      this.posted.delete(id);
      this.postedBytes -= bytes;
      return false;
    }
    this.stats.peakPostedBytes = Math.max(this.stats.peakPostedBytes, this.postedBytes);
    return true;
  }
}
