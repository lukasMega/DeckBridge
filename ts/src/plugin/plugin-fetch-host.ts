/** The plugin ctx.fetch proxy, run on the main thread for PluginHost (worker fetch
 *  would SIGABRT — see plugin-host.ts). Each request is owned by the worker that asked:
 *  one deadline covers headers and the whole body, bodies are capped in bytes, at most
 *  FETCH_MAX_CONCURRENT run at once, and only a still-current worker gets the answer. */
import type { MainToPluginWorker, PluginFetchInit } from './plugin-worker-protocol.js';

export const FETCH_TIMEOUT_MS = 10_000;
const FETCH_RESPONSE_MAX_BYTES = 1024 * 1024;
const FETCH_REQUEST_MAX_BYTES = 1024 * 1024;
/** Per host; excess requests fail at once (no queue). */
const FETCH_MAX_CONCURRENT = 4;

/** Where a result goes: the requesting worker. */
export interface FetchReplyTarget {
  postMessage(msg: MainToPluginWorker): void;
}

interface FetchRequest {
  key: string;
  worker: FetchReplyTarget;
  controller: AbortController;
  /** Why the controller aborted; reported instead of the runtime's generic AbortError. */
  reason: Error | null;
  /** The body reader while the body streams; abort cancels it directly, so a source
   *  that ignores the signal can't hold the read open. */
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  done: Promise<void>;
}

export class PluginFetchProxy {
  /** In-flight requests of the current worker, by the worker's fetchId. */
  private readonly requests = new Map<number, FetchRequest>();
  private readonly timeoutMs: number;
  private readonly isCurrent: (worker: FetchReplyTarget) => boolean;

  constructor(timeoutMs: number, isCurrent: (worker: FetchReplyTarget) => boolean) {
    this.timeoutMs = timeoutMs;
    this.isCurrent = isCurrent;
  }

  get size(): number {
    return this.requests.size;
  }

  /** Admit and run one request; `refusal` (e.g. host stopped) fails it at once. */
  start(
    worker: FetchReplyTarget,
    msg: { fetchId: number; key: string; url: string; init?: PluginFetchInit },
    refusal?: string,
  ): void {
    const { fetchId, key, url, init } = msg;
    const error = refusal ?? this.admissionError(fetchId, url, init);
    if (error) {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker.postMessage takes no targetOrigin
      worker.postMessage(fetchError(fetchId, error));
      return;
    }
    const req: FetchRequest = {
      key,
      worker,
      controller: new AbortController(),
      reason: null,
      reader: null,
      done: Promise.resolve(),
    };
    this.requests.set(fetchId, req);
    req.done = this.settle(fetchId, req, url, init);
  }

  /** Abort requests of plugin keys no longer configured. */
  abortRemoved(activeKeys: ReadonlySet<string>): void {
    for (const req of this.requests.values()) {
      if (!activeKeys.has(req.key)) abortFetch(req, new Error('plugin removed'));
    }
  }

  /** Abort everything (worker teardown) and forget it: a respawned worker restarts its
   *  fetch ids at 1. Returns the settlements to await. */
  abortAll(reason: string): Promise<void>[] {
    const done = [...this.requests.values()].map((req) => {
      abortFetch(req, new Error(reason));
      return req.done;
    });
    this.requests.clear();
    return done;
  }

  private async settle(
    fetchId: number,
    req: FetchRequest,
    url: string,
    init: PluginFetchInit | undefined,
  ): Promise<void> {
    let msg: MainToPluginWorker;
    try {
      msg = { type: 'fetchResult', fetchId, ...(await this.run(req, url, init)) };
    } catch (e) {
      msg = fetchError(fetchId, (req.reason ?? (e as Error)).message);
    }
    if (this.requests.get(fetchId) !== req) return;
    this.requests.delete(fetchId);
    // Only the worker that asked gets the answer, and only while it is current.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker.postMessage takes no targetOrigin
    if (this.isCurrent(req.worker)) req.worker.postMessage(msg);
  }

  private admissionError(
    fetchId: number,
    url: string,
    init: PluginFetchInit | undefined,
  ): string | null {
    if (!/^http:\/\//i.test(url)) return 'only http:// is supported (no TLS in this build)';
    if (init?.body && new TextEncoder().encode(init.body).byteLength > FETCH_REQUEST_MAX_BYTES) {
      return `request body exceeds ${FETCH_REQUEST_MAX_BYTES} bytes`;
    }
    if (this.requests.has(fetchId)) return 'duplicate fetch id';
    if (this.requests.size >= FETCH_MAX_CONCURRENT) {
      return `too many concurrent requests (max ${FETCH_MAX_CONCURRENT})`;
    }
    return null;
  }

  /** One deadline from request to the last body byte; the body is counted in bytes
   *  as it arrives, never buffered whole first. */
  private async run(
    req: FetchRequest,
    url: string,
    init: PluginFetchInit | undefined,
  ): Promise<{ ok: boolean; status: number; body: string }> {
    const { signal } = req.controller;
    const timer = setTimeout(() => abortFetch(req, new Error('fetch timeout')), this.timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const throwIfAborted = (): void => {
      if (signal.aborted) throw req.reason ?? new Error('fetch aborted');
    };
    try {
      const res = await fetch(url, {
        method: init?.method,
        headers: init?.headers,
        body: init?.body,
        signal,
      });
      throwIfAborted();
      const declared = Number(res.headers.get('content-length'));
      if (declared > FETCH_RESPONSE_MAX_BYTES) {
        abortFetch(req, new Error(`response exceeds ${FETCH_RESPONSE_MAX_BYTES} bytes`));
        await res.body?.cancel().catch(() => undefined);
        throw req.reason ?? new Error('fetch aborted');
      }
      if (!res.body) return { ok: res.ok, status: res.status, body: '' };
      reader = res.body.getReader();
      req.reader = reader;
      const decoder = new TextDecoder();
      let body = '';
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        throwIfAborted();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > FETCH_RESPONSE_MAX_BYTES) {
          abortFetch(req, new Error(`response exceeds ${FETCH_RESPONSE_MAX_BYTES} bytes`));
          throw req.reason ?? new Error('fetch aborted');
        }
        body += decoder.decode(value, { stream: true });
      }
      return { ok: res.ok, status: res.status, body: body + decoder.decode() };
    } finally {
      clearTimeout(timer);
      req.reader = null;
      if (reader) {
        if (signal.aborted) await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
  }
}

function abortFetch(req: FetchRequest, reason: Error): void {
  if (req.controller.signal.aborted) return;
  req.reason = reason;
  req.controller.abort(reason);
  void req.reader?.cancel(reason).catch(() => undefined);
}

function fetchError(fetchId: number, error: string): MainToPluginWorker {
  return { type: 'fetchResult', fetchId, ok: false, status: 0, body: '', error };
}
