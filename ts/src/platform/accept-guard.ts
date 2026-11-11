// txiki's accept callback calls getpeername() unguarded (direct-sockets/utils.js). A client
// that resets before the accept runs makes it throw EINVAL inside a native callback, and that
// stops the whole runtime. The wrapper drops that one connection instead: the accept stream
// then yields null, which callers skip with isDroppedAccept(). Remove once txiki catches it.

type AcceptFactory = (this: unknown, ...args: unknown[]) => unknown;

function closeHandle(handle: unknown): void {
  try {
    (handle as { close?: () => void } | null)?.close?.();
  } catch {
    // already closed
  }
}

/** Call right after `tjs.listen` resolves, before the first await. */
export function guardAccept(server: TjsTCPServerSocket, onDrop?: (error: unknown) => void): void {
  const target = server as unknown as { _createAcceptedSocket?: AcceptFactory };
  const original = target._createAcceptedSocket;
  if (typeof original !== 'function') return;
  target._createAcceptedSocket = function guardedAccept(...args: unknown[]): unknown {
    try {
      return original.apply(this, args);
    } catch (e) {
      closeHandle(args[1]);
      try {
        onDrop?.(e);
      } catch {
        // a throwing callback must not reach the native accept callback
      }
      return null;
    }
  };
}

/** True for the null a guarded accept stream yields for a dropped connection. */
export function isDroppedAccept(conn: TjsAcceptedTCPSocket | null): conn is null {
  return conn === null;
}
