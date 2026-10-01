/** Opt-in diagnostic image dumps (DECKBRIDGE_DUMP_DIR / DECKBRIDGE_RAW_DUMP_DIR). One
 *  serialized queue per worker keeps dir-create → write → evict in order, so eviction can
 *  never run ahead of a delayed write, and the pending bound caps in-flight I/O. */
import { warn } from '../shared/logger.js';

export const MAX_PENDING_DUMPS = 32;

export class DumpQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private closed = false;
  private warned = false;

  /** False when the dump was dropped (queue full or discarded). */
  enqueue(job: () => Promise<void>): boolean {
    if (this.closed) return false;
    if (this.pending >= MAX_PENDING_DUMPS) {
      if (!this.warned) {
        this.warned = true;
        warn('image', `image dump queue full (${MAX_PENDING_DUMPS}) — dropping new dumps`);
      }
      return false;
    }
    this.pending++;
    this.tail = this.tail
      .then(() => (this.closed ? undefined : job()))
      .catch((err: unknown) => warn('image', `image dump failed: ${String(err)}`))
      .finally(() => {
        this.pending--;
      });
    return true;
  }

  /** Resolves once everything accepted so far has been written and evicted. */
  drain(): Promise<void> {
    return this.tail;
  }

  /** Skip jobs not yet started (a closing worker must not keep writing). */
  discard(): void {
    this.closed = true;
  }

  get size(): number {
    return this.pending;
  }
}

/** A dump directory holding at most `keep` of this worker's files. */
export class DumpDir {
  private ready: Promise<boolean> | undefined;
  private readonly paths: string[] = [];

  constructor(
    private readonly dir: string,
    private readonly keep: number,
    private readonly queue: DumpQueue,
    /** Per-worker name prefix: workers share the dir and restart their sequences. */
    private readonly tag: string,
  ) {}

  /** Created lazily on the first accepted dump, awaited by every job after it. */
  private ensureDir(): Promise<boolean> {
    this.ready ??= tjs.makeDir(this.dir, { recursive: true }).then(
      () => true,
      (err: unknown) => {
        // An already-existing dump dir is success, not a failure to warn about.
        const ok = String(err).includes('EEXIST');
        if (!ok) warn('image', `failed to create dump dir ${this.dir}: ${String(err)}`);
        return ok;
      },
    );
    return this.ready;
  }

  /** Queue a write; false when it was dropped. */
  write(name: string, bytes: Uint8Array): boolean {
    const path = `${this.dir}/${this.tag}-${name}`;
    // Copy: the queue may run long after the caller's buffer is reused.
    const copy = bytes.slice();
    return this.queue.enqueue(async () => {
      if (!(await this.ensureDir())) return;
      try {
        await tjs.writeFile(path, copy);
        this.paths.push(path);
      } catch (err) {
        warn('image', `failed to write dump ${path}: ${String(err)}`);
      }
      while (this.paths.length > this.keep) {
        await tjs.remove(this.paths.shift()!).catch(() => undefined);
      }
    });
  }
}

export function newDumpTag(): string {
  const b = crypto.getRandomValues(new Uint8Array(3));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
