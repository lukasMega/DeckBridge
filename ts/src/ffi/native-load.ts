/** Shared plumbing for this folder's tjs:ffi bindings: buffers the native side
 *  fills, and the guarded-call shape every binding wraps its symbols in. */
import { warn } from '../logger.js';

// A machine with several composite HID devices can enumerate well over a hundred
// interfaces; 512 KB holds a few thousand rows before the native side truncates
// cleanly. Sized generously because device PRESENCE is answered from an enumeration
// (hidSnapshot) — a truncated tail would read as "device unplugged".
export const LIST_BUF_BYTES = 512 * 1024;

/** TSV absent-field marker written by the native enumeration. */
export const TSV_ABSENT = '-';

const DECODER = new TextDecoder();

/** Decode the NUL-terminated string the native side wrote into `buf`. */
export function decodeNulTerminated(buf: Uint8Array): string {
  const end = buf.indexOf(0);
  return DECODER.decode(buf.subarray(0, end >= 0 ? end : buf.length));
}

/** Degrade a throwing native call to `fallback` plus one warn line — an FFI fault
 *  must never escape into the enumeration/advertise callers. */
export function guardedCall<T>(name: string, fallback: T, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    warn('ffi', `${name} threw: ${String(e)}`);
    return fallback;
  }
}
