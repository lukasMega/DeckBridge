// Bounded HTTP GET for main-thread widget sources: one deadline covers headers and
// body, the body is size-capped, and every failure path cancels the response stream.
// (plugin/plugin-fetch-host.ts does the same for plugins; main may not import plugin code.)

export class BoundedHttpError extends Error {}

/** GET `url` and return the body text; throws on timeout, !ok or oversized body. */
export async function fetchTextBounded(
  url: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new BoundedHttpError('timeout')), timeoutMs);
  let reader = null as ReadableStreamDefaultReader<Uint8Array> | null;
  const abortedError = (): Error =>
    controller.signal.reason instanceof Error
      ? controller.signal.reason
      : new BoundedHttpError('aborted');
  // A function, not a property read: TS would keep the pre-await narrowing.
  const aborted = (): boolean => controller.signal.aborted;
  // Aborting also cancels the reader directly: a stream that ignores the signal
  // must not hold the read open past the deadline.
  controller.signal.addEventListener('abort', () => void reader?.cancel().catch(() => undefined));
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (aborted()) throw abortedError();
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new BoundedHttpError(`HTTP ${res.status}`);
    }
    if (Number(res.headers.get('content-length')) > maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw new BoundedHttpError(`response exceeds ${maxBytes} bytes`);
    }
    if (!res.body) return '';
    reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (aborted()) throw abortedError();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        controller.abort(new BoundedHttpError(`response exceeds ${maxBytes} bytes`));
        throw abortedError();
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    clearTimeout(timer);
    if (reader) {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}
