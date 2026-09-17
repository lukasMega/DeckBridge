// The browser UI's HTTP layer. Callers pass the failure prefix so each panel
// keeps its own wording; a server-supplied `error` field always wins over it.
import { useCallback, useEffect, useState } from 'preact/hooks';

function postInit(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // A string body is already-serialized JSON (settings import posts the file verbatim).
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  };
}

/** POST JSON and return the parsed reply. Throws `${what} (${status})` on failure,
 *  or the server's own `error` message when it sent one. */
export async function postJson<T = void>(
  url: string,
  body?: unknown,
  what = 'Request failed',
): Promise<T> {
  const r = await fetch(url, postInit(body));
  const parsed = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new Error(parsed.error ?? `${what} (${r.status})`);
  return parsed as T;
}

/** Fire-and-forget POST: these controls re-render from the status broadcast, not
 *  from the reply, so a failure has nothing to report. */
export function fire(url: string, body?: unknown): void {
  fetch(url, postInit(body)).catch(() => undefined);
}

export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, signal ? { signal } : {});
  if (!r.ok) throw new Error(`Request failed (${r.status})`);
  return (await r.json()) as T;
}

export interface Fetched<T> {
  data: T | null;
  error: string | null;
  /** Re-read the same URL, e.g. after a POST changed it. */
  reload: () => Promise<void>;
}

/** GET a URL once per mount, aborting on unmount. A failed read keeps the
 *  last-known data — these are best-effort previews, not the source of truth. */
export function useFetched<T>(url: string): Fetched<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      try {
        const value = await getJson<T>(url, signal);
        if (signal?.aborted === true) return;
        setData(value);
        setError(null);
      } catch (e) {
        if (signal?.aborted === true) return;
        setError((e as Error).message || 'Request failed.');
      }
    },
    [url],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  return { data, error, reload: () => load() };
}
