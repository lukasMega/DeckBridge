/** Main-thread host for ONE extension's worker: loads its server.js, batches dock
 *  events to it, proxies its HTTP calls and watches it with a heartbeat, like
 *  plugin-host.ts. Unlike plugins, crashes are not forgiven by a later pong: the
 *  third death stops the extension until the user enables it again. */
import extensionWorkerSource from 'virtual:extension-worker';
import { revokeBlobUrl, spawnWorker, terminateDeferred } from '../shared/worker-lifecycle.js';
import { log } from '../shared/logger.js';
import type { LogLevel } from '../shared/logger.js';
import type { ExtensionEvent, ExtensionEventType, ExtensionRequest } from './api.js';
import { MAX_REPLY_CHARS } from './extension-worker-protocol.js';
import type { ExtensionWorkerToMain, MainToExtensionWorker } from './extension-worker-protocol.js';

const HEARTBEAT_MS = 2000;
const MAX_MISSED_PONGS = 2; // ~4 s of silence → presume the worker wedged
const MAX_KILLS = 3;
const FLUSH_MS = 250;
const MAX_QUEUED_EVENTS = 5000;
const REQUEST_TIMEOUT_MS = 5000;
const MAX_PENDING_REQUESTS = 8;
// The worker is untrusted: its log lines are capped in size and rate. See onWorkerLog.
const MAX_LOG_CHARS = 500;
const MAX_LOG_LINES_PER_S = 20;

/** Worker text as one capped line: control characters (newlines too) would forge extra lines. */
const oneLine = (text: unknown): string =>
  String(text)
    .replace(/\p{Cc}+/gu, ' ')
    .slice(0, MAX_LOG_CHARS);

export type ExtensionRunState = 'loading' | 'running' | 'error';

export interface ExtensionReply {
  status: number;
  /** Serialized by the worker; the route sends it as-is. */
  json: string;
}

/** The subset of Worker the host uses — injectable so tests drive a fake. */
export interface WorkerLike {
  postMessage(msg: MainToExtensionWorker): void;
  terminate(): void;
  addEventListener(type: 'message' | 'error', listener: (ev: MessageEvent) => void): void;
}
export type WorkerFactory = () => WorkerLike;

function defaultWorkerFactory(): WorkerLike {
  const { worker: w, url } = spawnWorker(extensionWorkerSource);
  return {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker.postMessage takes no targetOrigin
    postMessage: (m) => w.postMessage(m),
    terminate: () => {
      try {
        w.terminate();
      } finally {
        revokeBlobUrl(url);
      }
    },
    addEventListener: (t, l) => w.addEventListener(t, l as EventListener),
  };
}

export interface ExtensionHostOptions {
  id: string;
  /** Absolute path of the extension's server.js. */
  serverPath: string;
  appStartedAt: number;
  /** `state` or `error` changed. */
  onState: () => void;
  /** Sent first to every worker it starts (the attached decks): a restart loses them. */
  initialEvents?: () => ExtensionEvent[];
  /** The types the extension's grant covers; any other type is dropped here, before queueing. */
  events: readonly ExtensionEventType[];
  workerFactory?: WorkerFactory;
}

const reply = (status: number, error: string): ExtensionReply => ({
  status,
  json: JSON.stringify({ error }),
});

export class ExtensionHost {
  state: ExtensionRunState = 'loading';
  error: string | undefined;
  private readonly workerFactory: WorkerFactory;
  private readonly events: ReadonlySet<ExtensionEventType>;
  private worker: WorkerLike | null = null;
  private queue: ExtensionEvent[] = [];
  private dropped = 0;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private hbTimer: ReturnType<typeof setInterval> | undefined;
  private awaitingPong = false;
  private missedPongs = 0;
  private pingSeq = 0;
  private kills = 0;
  private logWindowStart: number | undefined;
  private logWindowLines = 0;
  private logSuppressed = 0;
  private reqSeq = 0;
  private readonly pending = new Map<
    number,
    { resolve: (r: ExtensionReply) => void; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(private readonly opts: ExtensionHostOptions) {
    this.workerFactory = opts.workerFactory ?? defaultWorkerFactory;
    this.events = new Set(opts.events);
  }

  start(): void {
    this.spawn();
    this.hbTimer = setInterval(() => this.hbTick(), HEARTBEAT_MS);
  }

  /** Queued while the worker loads; sent in one batch per FLUSH_MS once it runs. */
  emit(event: ExtensionEvent): void {
    // Filtered before queueing, so an undeclared type never counts toward the cap.
    if (this.state === 'error' || !this.events.has(event.type)) return;
    if (this.queue.length >= MAX_QUEUED_EVENTS) {
      this.dropped++;
      return;
    }
    this.queue.push(event);
    if (this.state === 'running' && this.flushTimer === undefined) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        this.flush();
      }, FLUSH_MS);
    }
  }

  /** Never rejects: an unavailable or slow extension answers with a 5xx reply. */
  request(req: ExtensionRequest): Promise<ExtensionReply> {
    if (this.state !== 'running' || !this.worker) {
      return Promise.resolve(reply(503, `extension is ${this.state}`));
    }
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.resolve(reply(503, 'too many requests in flight'));
    }
    const reqId = ++this.reqSeq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        resolve(reply(504, 'extension did not answer in time'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(reqId, { resolve, timer });
      this.post({ type: 'request', reqId, ...req });
    });
  }

  /** Terminal: terminate the worker and answer every pending request. */
  stop(): void {
    clearInterval(this.hbTimer);
    this.hbTimer = undefined;
    this.teardownWorker('extension stopped');
    this.queue = [];
  }

  private spawn(): void {
    const w = this.workerFactory();
    this.worker = w;
    // A replaced worker's late messages (request ids restart) must not reach this one.
    w.addEventListener('message', (e) => {
      if (this.worker === w) this.onMessage(e.data as ExtensionWorkerToMain);
    });
    w.addEventListener('error', (e) => {
      if (this.worker === w) {
        this.onWorkerDead((e as unknown as { message?: string }).message ?? 'worker error');
      }
    });
    this.awaitingPong = false;
    this.missedPongs = 0;
    const initial = (this.opts.initialEvents?.() ?? []).filter((e) => this.events.has(e.type));
    this.queue = [...initial, ...this.queue];
    this.setState('loading');
    const { id, serverPath, appStartedAt } = this.opts;
    this.post({ type: 'load', id, path: serverPath, appStartedAt });
  }

  private onMessage(msg: ExtensionWorkerToMain): void {
    switch (msg.type) {
      case 'loaded':
        this.setState('running');
        this.flush(); // what queued while it loaded
        break;
      case 'loadError':
        this.fail(`load failed: ${oneLine(msg.message)}`);
        break;
      case 'response': {
        const slot = this.pending.get(msg.reqId);
        if (!slot) return;
        this.pending.delete(msg.reqId);
        clearTimeout(slot.timer);
        // An out-of-range status would make the Response constructor throw. The worker
        // checks the size too; the host checks again because the worker is untrusted.
        const ok =
          Number.isInteger(msg.status) &&
          msg.status >= 200 &&
          msg.status <= 599 &&
          typeof msg.json === 'string' &&
          msg.json.length <= MAX_REPLY_CHARS;
        slot.resolve(ok ? { status: msg.status, json: msg.json } : reply(500, 'bad reply'));
        break;
      }
      case 'pong':
        this.awaitingPong = false;
        break;
      case 'log':
        this.onWorkerLog(msg.level, msg.message);
        break;
    }
  }

  private flush(): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.queue.length > 0) this.post({ type: 'events', events: this.queue });
    this.queue = [];
    if (this.dropped > 0) {
      log('warn', 'extensions', `${this.opts.id}: dropped ${this.dropped} events (queue full)`);
      this.dropped = 0;
    }
  }

  private hbTick(): void {
    if (this.awaitingPong) {
      this.missedPongs++;
      if (this.missedPongs >= MAX_MISSED_PONGS) {
        this.onWorkerDead('heartbeat timeout');
        return;
      }
    } else {
      this.missedPongs = 0;
    }
    this.post({ type: 'ping', seq: ++this.pingSeq });
    this.awaitingPong = true;
  }

  private onWorkerDead(reason: string): void {
    this.kills++;
    if (this.kills >= MAX_KILLS) {
      this.fail(`stopped after ${this.kills} crashes (last: ${reason})`);
      return;
    }
    log('warn', 'extensions', `${this.opts.id}: worker died (${reason}); restarting`);
    this.teardownWorker('extension restarted');
    this.spawn();
  }

  private fail(message: string): void {
    log('warn', 'extensions', `${this.opts.id}: ${message}`);
    this.error = message;
    this.stop();
    this.setState('error');
  }

  /** Extension output: one line per message, capped in size and count per second. */
  private onWorkerLog(level: LogLevel, message: unknown): void {
    const now = Date.now();
    if (this.logWindowStart === undefined || now - this.logWindowStart >= 1000) {
      if (this.logSuppressed > 0) {
        log('warn', 'extensions', `${this.opts.id}: suppressed ${this.logSuppressed} log lines`);
        this.logSuppressed = 0;
      }
      this.logWindowStart = now;
      this.logWindowLines = 0;
    }
    if (this.logWindowLines >= MAX_LOG_LINES_PER_S) {
      this.logSuppressed++;
      return;
    }
    this.logWindowLines++;
    log(level === 'warn' ? 'warn' : 'info', `ext:${this.opts.id}`, oneLine(message));
  }

  private teardownWorker(why: string): void {
    const w = this.worker;
    this.worker = null;
    this.awaitingPong = false;
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    for (const [reqId, slot] of this.pending) {
      clearTimeout(slot.timer);
      slot.resolve(reply(503, why));
      this.pending.delete(reqId);
    }
    // Deferred a macrotask — see terminateDeferred (worker-lifecycle.ts).
    if (w) terminateDeferred(w);
  }

  private setState(state: ExtensionRunState): void {
    if (this.state === state) return;
    this.state = state;
    this.opts.onState();
  }

  private post(msg: MainToExtensionWorker): void {
    this.worker?.postMessage(msg);
  }
}
