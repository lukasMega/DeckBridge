// txiki's accept callback calls getpeername() unguarded (direct-sockets/utils.js). A client
// that resets before the accept runs makes it throw EINVAL inside a native callback, and that
// stops the whole runtime. The wrapper drops that one connection instead: the accept stream
// then yields null, which callers skip with isDroppedAccept(). Remove once txiki catches it.

/** libuv takes seconds. Probes start after 30 s idle so a vanished peer is noticed. */
export const KEEPALIVE_DELAY_S = 30;

type AcceptFactory = (this: unknown, ...args: unknown[]) => unknown;

function closeHandle(handle: unknown): void {
  try {
    (handle as { close?: () => void } | null)?.close?.();
  } catch {
    // already closed
  }
}

/** Nagle would hold a small CORA ACK or key event until the peer's delayed ACK (tens of ms). */
function tuneAccepted(handle: unknown): void {
  const h = handle as {
    setNoDelay?: (on: boolean) => void;
    setKeepAlive?: (on: boolean, s: number) => void;
  } | null;
  try {
    h?.setNoDelay?.(true);
    h?.setKeepAlive?.(true, KEEPALIVE_DELAY_S);
  } catch {
    // best effort: a reset peer must not fail the accept
  }
}

/** Call right after `tjs.listen` resolves, before the first await. */
export function guardAccept(server: TjsTCPServerSocket, onDrop?: (error: unknown) => void): void {
  const target = server as unknown as { _createAcceptedSocket?: AcceptFactory };
  const original = target._createAcceptedSocket;
  if (typeof original !== 'function') return;
  target._createAcceptedSocket = function guardedAccept(...args: unknown[]): unknown {
    try {
      const socket = original.apply(this, args);
      tuneAccepted(args[1]);
      return socket;
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
