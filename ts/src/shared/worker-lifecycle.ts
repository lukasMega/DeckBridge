/** Spawn + teardown shared by the three worker hosts (hid, hid-scan, plugin).
 *  Lifecycle ONLY: their message protocols — event stream vs single-in-flight
 *  request/response vs reverse RPC + heartbeat — are deliberately not unified. */

/** Bundled worker source → a running module Worker. A blob URL is the only
 *  option: the standalone binary has no worker file on disk to point at. */
export function spawnWorker(source: string): { worker: Worker; url: string } {
  const url = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
  return { worker: new Worker(url, { type: 'module' }), url };
}

/** Best-effort — a spawned worker already holds its loaded source, so a failed
 *  revoke costs nothing. */
export function revokeBlobUrl(url: string): void {
  try {
    URL.revokeObjectURL(url);
  } catch {
    /* ignore */
  }
}

/** Null your worker ref synchronously (open()'s reject path is observed
 *  immediately by callers), but defer the native terminate() through this.
 *  Calling Worker.terminate() synchronously from inside an onmessage/onerror
 *  callback — e.g. the throwaway "unknown modelId" worker that posts an error
 *  then is torn down at once — races txiki's worker libuv loop mid-flush and
 *  SIGSEGVs. `delayMs` lets the worker thread settle to idle before it is killed:
 *  0 (a bare macrotask) is enough when the worker cannot be mid native call (open
 *  failure, graceful close already drained via 'close'), but a physical
 *  disconnect can land mid an in-flight FFI image transform or hid_write, so that
 *  path passes a grace delay instead. */
export function terminateDeferred(w: { terminate(): void }, delayMs = 0): void {
  setTimeout(() => {
    try {
      w.terminate();
    } catch {
      /* gone */
    }
  }, delayMs);
}
